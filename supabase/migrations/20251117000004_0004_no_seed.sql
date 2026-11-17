-- MeetSync 3D — 0004: seed-free guardrail
-- ---------------------------------------------------------------------------
-- Intentionally NO seed data. Demo data lives ONLY in:
--   * src/data/mockData.ts (demo/mock service), and
--   * docs/seed-example.sql (optional, manual, documented snippet —
--     never auto-applied by migrations).
--
-- This file exists so the migration chain documents that choice and so a
-- future author does not add INSERTs here by accident. It performs a
-- no-op verification that RLS is enabled on every application table.
-- ---------------------------------------------------------------------------

do $$
declare
  missing text;
begin
  select string_agg(tablename, ', ')
    into missing
  from pg_tables
  where schemaname = 'public'
    and tablename in (
      'meeting_rooms', 'participants', 'participant_locations',
      'candidate_spots', 'route_estimates', 'votes'
    )
    and not rowsecurity;

  if missing is not null then
    raise exception 'RLS is not enabled on: %', missing;
  end if;
end
$$;
