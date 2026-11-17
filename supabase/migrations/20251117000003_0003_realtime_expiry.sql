-- MeetSync 3D — 0003: Realtime publication + location expiration / cleanup
-- ---------------------------------------------------------------------------
-- Realtime: lobby updates need postgres_changes on meeting_rooms and
-- participants. Wrapped in DO blocks so applying this migration against a
-- project without the supabase_realtime publication (or with tables
-- already added) does not fail.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.meeting_rooms;
    exception when duplicate_object then
      null;
    end;
    begin
      alter publication supabase_realtime add table public.participants;
    exception when duplicate_object then
      null;
    end;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Location expiration: expires_at = updated_at + 2 hours, enforced by trigger.
-- This replaces the plain set_updated_at trigger on participant_locations
-- with a combined trigger so expiry always tracks the latest update.
-- ---------------------------------------------------------------------------

create index if not exists idx_participant_locations_expires_at on public.participant_locations (expires_at);

create or replace function public.set_location_expiry()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.expires_at = new.updated_at + interval '2 hours';
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.participant_locations;
drop trigger if exists set_location_expiry on public.participant_locations;
create trigger set_location_expiry
  before insert or update on public.participant_locations
  for each row execute function public.set_location_expiry();

-- ---------------------------------------------------------------------------
-- Cleanup functions (SECURITY DEFINER — called by the cleanup Edge Function
-- with the service-role key, never directly by browser clients).
-- ---------------------------------------------------------------------------

create or replace function public.delete_expired_locations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.participant_locations where expires_at < now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Alias/wrapper kept for scheduled jobs that call the expire_* name.
-- Returns the number of expired locations deleted.
create or replace function public.expire_old_locations()
returns integer
language sql
security definer
set search_path = public
as $$
  select public.delete_expired_locations();
$$;

-- ---------------------------------------------------------------------------
-- Scheduling (do NOT uncomment blindly — pick ONE mechanism, see SUPABASE.md):
--
-- Option A — pg_cron (requires pg_cron extension + cron schema):
--   select cron.schedule(
--     'meetsync-cleanup-expired-locations',
--     '*/15 * * * *',
--     $$select public.delete_expired_locations();$$
--   );
--
-- Option B — Supabase Scheduled Edge Function invoking
--   cleanup-expired-locations with the CLEANUP_SECRET header (preferred:
--   also prunes long-expired rooms; see supabase/functions/
--   cleanup-expired-locations/index.ts).
-- ---------------------------------------------------------------------------

comment on function public.delete_expired_locations() is 'Deletes participant_locations past expires_at. Called by cleanup Edge Function / pg_cron only.';
