-- MeetSync 3D — 0005: group coordination
-- ---------------------------------------------------------------------------
-- * meeting_rooms.decision_version (optimistic lock for finalization) +
--   finalized_at (when the host finalized).
-- * participants.arrived_at (optional arrival confirmation).
-- * Realtime publication adds for votes + participant_locations so vote
--   and location changes reach open pages live (guarded DO blocks, same
--   pattern as migration 0003).
-- * expire_rooms() — marks past-expires_at, non-finalized rooms
--   'expired'. Finalized rooms are NEVER auto-expired: every
--   participant must keep seeing the same finalized destination.
--   Long-expired/finalized rooms are pruned by age in the cleanup
--   Edge Function instead (see SUPABASE.md).
-- * The participants privilege-change trigger is recreated with
--   arrived_at documented as an allowed self-update column. The
--   blocked set is unchanged (id, room_id, auth_uid, is_host,
--   avatar_color, joined_at); arrived_at was never blocked, so this
--   is a documentation-only change to the function body.
--
-- Idempotent and backward compatible: new columns have defaults, no
-- existing rows are modified except by the expire_rooms() function
-- when it is called, and no policies are removed. RLS stays enabled.
-- No seed data.
-- ---------------------------------------------------------------------------

alter table public.meeting_rooms
  add column if not exists decision_version integer not null default 1;

alter table public.meeting_rooms
  add column if not exists finalized_at timestamptz;

alter table public.participants
  add column if not exists arrived_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'meeting_rooms_decision_version_check'
  ) then
    alter table public.meeting_rooms
      add constraint meeting_rooms_decision_version_check
      check (decision_version >= 1);
  end if;
end
$$;

create index if not exists idx_meeting_rooms_status_expires
  on public.meeting_rooms (status, expires_at);

-- ---------------------------------------------------------------------------
-- expire_rooms(): SECURITY DEFINER — called by the cleanup Edge Function
-- with the service-role key, never directly by browser clients.
-- Marks only open rooms (lobby/discovering/comparing) whose expires_at
-- has passed. Returns the number of rooms marked expired.
-- ---------------------------------------------------------------------------

create or replace function public.expire_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  expired_count integer;
begin
  update public.meeting_rooms
  set status = 'expired'
  where status in ('lobby', 'discovering', 'comparing')
    and expires_at < now();
  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

comment on function public.expire_rooms() is 'Marks past-expires_at open rooms expired. Finalized rooms are never auto-expired. Called by cleanup Edge Function only.';

-- ---------------------------------------------------------------------------
-- Realtime publication adds: votes + participant_locations.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.votes;
    exception when duplicate_object then
      null;
    end;
    begin
      alter publication supabase_realtime add table public.participant_locations;
    exception when duplicate_object then
      null;
    end;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Participants trigger: recreate with arrived_at documented as allowed.
-- Self-updates may change is_ready, display_name, last_seen_at and
-- arrived_at only. The blocked set is unchanged from migration 0002.
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
    raise exception 'participants: only is_ready, display_name, last_seen_at and arrived_at may be updated';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_participant_privilege_change on public.participants;
create trigger prevent_participant_privilege_change
  before update on public.participants
  for each row execute function public.prevent_participant_privilege_change();

comment on column public.meeting_rooms.decision_version is 'Optimistic-lock counter for decisions. Increments on every finalize; clients pass the version they saw and get 409 on mismatch.';
comment on column public.meeting_rooms.finalized_at is 'When the host finalized the meeting (null until finalized).';
comment on column public.participants.arrived_at is 'Optional arrival confirmation timestamp (null = not arrived). Only the participant themselves may set it.';
