-- MeetSync 3D — 0002: Row Level Security
-- ---------------------------------------------------------------------------
-- Threat model
-- ---------------------------------------------------------------------------
-- * Anyone with an invite link can join, but nobody may enumerate rooms or
--   read another room's participants, locations, spots or votes.
-- * Room discovery by invite code happens ONLY via the join-room Edge
--   Function (service-role client). Direct SELECT on meeting_rooms is
--   restricted to current members, so an unauthenticated / non-member
--   SELECT by invite code returns no rows.
-- * All privileged writes (create room, join, update location, finalize)
--   go through Edge Functions using the service-role key, which bypasses
--   RLS. There are deliberately NO direct INSERT/UPDATE/DELETE policies
--   for authenticated users on meeting_rooms, participants (except the
--   narrow self-readiness update below), participant_locations,
--   candidate_spots or route_estimates.
-- * Participants may update ONLY their own row, and only is_ready /
--   display_name / last_seen_at. A trigger blocks is_host / room_id /
--   auth_uid changes because RLS policies alone cannot restrict columns
--   on UPDATE reliably (see prevent_participant_privilege_change).
-- * Votes are the one direct-write exception: a member may insert /
--   update / delete ONLY votes whose participant row belongs to them
--   (owns_participant helper).
-- * Anonymous Supabase auth users act with the `authenticated` role once
--   signed in. The bare `anon` role gets no write policies and its
--   INSERT/UPDATE/DELETE grants are revoked below.
-- ---------------------------------------------------------------------------

alter table public.meeting_rooms enable row level security;
alter table public.participants enable row level security;
alter table public.participant_locations enable row level security;
alter table public.candidate_spots enable row level security;
alter table public.route_estimates enable row level security;
alter table public.votes enable row level security;

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helpers (bypass RLS to avoid infinite recursion).
-- search_path is pinned to public. STABLE: no writes.
-- ---------------------------------------------------------------------------

create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.participants p
    where p.room_id = p_room_id
      and p.auth_uid = auth.uid()
  );
$$;

create or replace function public.is_room_host(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.participants p
    where p.room_id = p_room_id
      and p.auth_uid = auth.uid()
      and p.is_host = true
  );
$$;

create or replace function public.owns_participant(p_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.participants p
    where p.id = p_participant_id
      and p.auth_uid = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Trigger: block privilege / identity changes on participants UPDATE.
-- RLS policy below allows self UPDATE; this trigger narrows it to
-- is_ready / display_name / last_seen_at only.
-- ---------------------------------------------------------------------------

create or replace function public.prevent_participant_privilege_change()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
    or new.room_id is distinct from old.room_id
    or new.auth_uid is distinct from old.auth_uid
    or new.is_host is distinct from old.is_host
    or new.avatar_color is distinct from old.avatar_color
    or new.joined_at is distinct from old.joined_at then
    raise exception 'participants: only is_ready, display_name and last_seen_at may be updated';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_participant_privilege_change on public.participants;
create trigger prevent_participant_privilege_change
  before update on public.participants
  for each row execute function public.prevent_participant_privilege_change();

-- ---------------------------------------------------------------------------
-- Policies — drop-then-create so the migration is re-runnable.
-- ---------------------------------------------------------------------------

-- meeting_rooms: members can read their own room. NO direct writes.
drop policy if exists meeting_rooms_select_member on public.meeting_rooms;
create policy meeting_rooms_select_member
  on public.meeting_rooms for select
  to authenticated
  using (public.is_room_member(id));

-- participants: members can read co-participants in the same room.
drop policy if exists participants_select_member on public.participants;
create policy participants_select_member
  on public.participants for select
  to authenticated
  using (public.is_room_member(room_id));

-- participants: update ONLY your own row (trigger narrows the columns).
drop policy if exists participants_update_own on public.participants;
create policy participants_update_own
  on public.participants for update
  to authenticated
  using (auth_uid = auth.uid())
  with check (auth_uid = auth.uid());

-- participant_locations: members can read locations in their room. NO direct writes.
drop policy if exists participant_locations_select_member on public.participant_locations;
create policy participant_locations_select_member
  on public.participant_locations for select
  to authenticated
  using (public.is_room_member(room_id));

-- candidate_spots: members can read spots in their room. NO direct writes.
drop policy if exists candidate_spots_select_member on public.candidate_spots;
create policy candidate_spots_select_member
  on public.candidate_spots for select
  to authenticated
  using (public.is_room_member(room_id));

-- route_estimates: members can read estimates in their room. NO direct writes.
drop policy if exists route_estimates_select_member on public.route_estimates;
create policy route_estimates_select_member
  on public.route_estimates for select
  to authenticated
  using (public.is_room_member(room_id));

-- votes: members can read votes in their room.
drop policy if exists votes_select_member on public.votes;
create policy votes_select_member
  on public.votes for select
  to authenticated
  using (public.is_room_member(room_id));

-- votes: insert / update / delete ONLY your own participant row.
drop policy if exists votes_insert_own on public.votes;
create policy votes_insert_own
  on public.votes for insert
  to authenticated
  with check (public.owns_participant(participant_id) and public.is_room_member(room_id));

drop policy if exists votes_update_own on public.votes;
create policy votes_update_own
  on public.votes for update
  to authenticated
  using (public.owns_participant(participant_id))
  with check (public.owns_participant(participant_id) and public.is_room_member(room_id));

drop policy if exists votes_delete_own on public.votes;
create policy votes_delete_own
  on public.votes for delete
  to authenticated
  using (public.owns_participant(participant_id));

-- Deny the bare anon role direct writes (anon-auth users act as
-- `authenticated` once signed in, so this does not block real users).
revoke insert, update, delete on public.meeting_rooms from anon;
revoke insert, update, delete on public.participants from anon;
revoke insert, update, delete on public.participant_locations from anon;
revoke insert, update, delete on public.candidate_spots from anon;
revoke insert, update, delete on public.route_estimates from anon;
revoke insert, update, delete on public.votes from anon;

comment on table public.meeting_rooms is 'RLS: members-only SELECT. Writes only via Edge Functions (service role).';
comment on table public.participant_locations is 'RLS: members-only SELECT. Writes only via update-location Edge Function. Locations expire after 2 hours.';
