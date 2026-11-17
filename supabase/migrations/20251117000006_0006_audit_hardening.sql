-- MeetSync 3D — 0006: audit hardening (votes guards, atomic replace, RPC lockdown, location SELECT expiry)
-- ---------------------------------------------------------------------------
-- Applies the security fixes from the 2026-11-17 audit:
--
-- * M-7 — The SECURITY DEFINER cleanup/expire functions were callable by
--   ANYONE via PostgREST RPC (default EXECUTE TO PUBLIC), bypassing the
--   CLEANUP_SECRET gate on the cleanup Edge Function. EXECUTE is now
--   revoked from PUBLIC/anon/authenticated and granted to service_role
--   and postgres only. postgres covers pg_cron callers (migration 0003
--   Option A runs as the database owner). Deliberately NO auth.role()
--   assertion inside the functions: pg_cron calls them without a JWT,
--   and an assertion would break scheduled cleanup.
--
-- * M-8 — Votes RLS checked only ownership + membership: a member could
--   vote in finalized/expired rooms, with cross-room participant/spot
--   ids, and with duplicate rank 1 (inflating firstChoiceCount). A
--   BEFORE INSERT OR UPDATE trigger now enforces: room status is open
--   (lobby/discovering/comparing), room not expired, and the
--   participant + spot both belong to the vote's room. A unique index
--   on (room_id, participant_id, rank) makes duplicate ranks
--   impossible at the storage layer. NOTE: creating the unique index
--   fails if existing rows already violate it — inspect and clean up
--   duplicate ranks before re-applying if that happens.
--
-- * M-9 — Atomic vote replacement. replace_votes() deletes + inserts a
--   participant's ranking in ONE transaction (the client previously
--   did delete-then-insert across two requests, which could strand a
--   participant with no ranking). It re-checks ownership, room state,
--   spot membership, non-emptiness and duplicate spot ids, serializes
--   concurrent replaces for the same participant with a row lock, and
--   returns the saved rows. EXECUTE is granted to authenticated only
--   (plus service_role); PUBLIC/anon are revoked.
--
-- * #27 — Expired locations stayed readable via RLS until the cleanup
--   job ran; expiry was client-side only. The participant_locations
--   SELECT policy now requires expires_at > now(), so expired rows are
--   invisible to members immediately. TRADEOFF: clients can no longer
--   distinguish "never shared a location" from "location expired" in
--   live mode — both read as no location. Client-side freshness
--   checks (hasFreshLocation) remain as defence in depth for demo
--   mode and the boundary window.
--
-- Idempotent where possible (drop-then-create policies/triggers,
-- CREATE OR REPLACE functions, IF NOT EXISTS indexes). Apply via the
-- Supabase Dashboard SQL Editor, after migrations 0001–0005.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- M-7: lock down SECURITY DEFINER cleanup/expire functions.
-- ---------------------------------------------------------------------------

revoke execute on function public.delete_expired_locations() from public, anon, authenticated;
revoke execute on function public.expire_old_locations() from public, anon, authenticated;
revoke execute on function public.expire_rooms() from public, anon, authenticated;

grant execute on function public.delete_expired_locations() to service_role, postgres;
grant execute on function public.expire_old_locations() to service_role, postgres;
grant execute on function public.expire_rooms() to service_role, postgres;

-- ---------------------------------------------------------------------------
-- M-8: votes validity trigger + unique rank.
-- ---------------------------------------------------------------------------

create or replace function public.check_vote_validity()
returns trigger
language plpgsql
as $$
declare
  v_status text;
  v_expires_at timestamptz;
  v_participant_room uuid;
  v_spot_room uuid;
begin
  select status, expires_at into v_status, v_expires_at
  from public.meeting_rooms
  where id = new.room_id;

  if not found then
    raise exception 'votes: room not found';
  end if;
  if v_status not in ('lobby', 'discovering', 'comparing') then
    raise exception 'votes: voting is closed for this room';
  end if;
  if v_expires_at < now() then
    raise exception 'votes: this room has expired';
  end if;

  select room_id into v_participant_room
  from public.participants
  where id = new.participant_id;
  if not found or v_participant_room is distinct from new.room_id then
    raise exception 'votes: participant does not belong to this room';
  end if;

  select room_id into v_spot_room
  from public.candidate_spots
  where id = new.spot_id;
  if not found or v_spot_room is distinct from new.room_id then
    raise exception 'votes: spot does not belong to this room';
  end if;

  return new;
end;
$$;

drop trigger if exists check_vote_validity on public.votes;
create trigger check_vote_validity
  before insert or update on public.votes
  for each row execute function public.check_vote_validity();

create unique index if not exists votes_rank_unique
  on public.votes (room_id, participant_id, rank);

-- ---------------------------------------------------------------------------
-- M-9: atomic replace_votes() RPC.
-- ---------------------------------------------------------------------------

create or replace function public.replace_votes(
  p_room_id uuid,
  p_participant_id uuid,
  p_spot_ids uuid[]
)
returns setof public.votes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_uid uuid;
  v_status text;
  v_expires_at timestamptz;
  v_participant_room uuid;
  v_spot_count integer;
begin
  -- Ownership: the caller's JWT must own the participant row.
  select auth_uid, room_id into v_auth_uid, v_participant_room
  from public.participants
  where id = p_participant_id;
  if not found or v_auth_uid is distinct from auth.uid() then
    raise exception 'votes: you must join this room before voting';
  end if;
  if v_participant_room is distinct from p_room_id then
    raise exception 'votes: participant does not belong to this room';
  end if;

  -- Serialize concurrent replaces for the same participant: without
  -- the lock, two overlapping calls could interleave delete/insert.
  perform 1 from public.participants where id = p_participant_id for update;

  select status, expires_at into v_status, v_expires_at
  from public.meeting_rooms
  where id = p_room_id;
  if not found then
    raise exception 'votes: room not found';
  end if;
  if v_status not in ('lobby', 'discovering', 'comparing') then
    raise exception 'votes: voting is closed for this room';
  end if;
  if v_expires_at < now() then
    raise exception 'votes: this room has expired';
  end if;

  if p_spot_ids is null or cardinality(p_spot_ids) = 0 then
    raise exception 'votes: a ranking must include at least one spot';
  end if;
  if (select count(*) from unnest(p_spot_ids)) <>
     (select count(distinct spot_id) from unnest(p_spot_ids) as spot_id) then
    raise exception 'votes: a ranking cannot include the same spot twice';
  end if;

  select count(*) into v_spot_count
  from public.candidate_spots
  where room_id = p_room_id
    and id = any (p_spot_ids);
  if v_spot_count <> cardinality(p_spot_ids) then
    raise exception 'votes: one or more spots do not belong to this room';
  end if;

  delete from public.votes
  where room_id = p_room_id and participant_id = p_participant_id;

  insert into public.votes (room_id, participant_id, spot_id, rank)
  select p_room_id, p_participant_id, spot_id, rnk::integer
  from unnest(p_spot_ids) with ordinality as t(spot_id, rnk);

  return query
    select * from public.votes
    where room_id = p_room_id and participant_id = p_participant_id
    order by rank;
end;
$$;

revoke execute on function public.replace_votes(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.replace_votes(uuid, uuid, uuid[]) to authenticated, service_role;

comment on function public.replace_votes(uuid, uuid, uuid[]) is 'Atomically replaces one participant ranking (delete + insert in one transaction). Enforces ownership, open room, spot membership. Called by the browser client via PostgREST RPC.';

-- ---------------------------------------------------------------------------
-- #27: expired locations are no longer SELECT-visible to members.
-- ---------------------------------------------------------------------------

drop policy if exists participant_locations_select_member on public.participant_locations;
create policy participant_locations_select_member
  on public.participant_locations for select
  to authenticated
  using (public.is_room_member(room_id) and expires_at > now());

comment on table public.participant_locations is 'RLS: members-only SELECT of UNEXPIRED locations (expires_at > now()). Writes only via update-location Edge Function. Locations expire after 2 hours.';
