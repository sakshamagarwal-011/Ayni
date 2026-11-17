-- MeetSync 3D — 0009: shared published rank for live spots
-- ---------------------------------------------------------------------------
-- * candidate_spots.published_rank — the rank (1..5) of a spot in the
--   LATEST published batch, or NULL when the spot is not in the latest
--   batch. Owned exclusively by the publish-results Edge Function:
--   every publish writes 1..N (1-based, in submitted order) onto the
--   published rows and clears the rank on every other spot in the
--   room, so a re-publish SUPERSEDES the previous batch instead of
--   merging with it.
--
--   Why server-side: the published ranking must be shared and
--   server-authoritative. Before this migration the ranking lived
--   only in the publisher's sessionStorage (engine order), so other
--   participants' Compare pages ordered unvoted spots by creation
--   order (seeded demo spots first) and capped at 5 — published
--   spots beyond the cap could never be ranked. With published_rank
--   every browser orders the compared set the same way: latest
--   published batch first (rank order), remainder by group tally.
--   The sessionStorage engine order still takes precedence when
--   present (the publisher's own view + demo mode), as a display
--   hint only. See COORDINATION.md.
--
-- * CHECK constraint (null or 1..5): a publish carries at most 5
--   places, so no valid rank can exceed 5. Added in a guarded DO
--   block (same pattern as migration 0005) so re-running is safe.
--
-- * NO RLS changes: writes stay Edge-Function-only (service-role
--   client), same as osm_id in migration 0008. Members already have
--   SELECT on candidate_spots, so the rank is readable by the whole
--   room with no policy change.
--
-- * NO Realtime publication change: candidate_spots is deliberately
--   NOT in the supabase_realtime publication. Propagation rides the
--   decision_version bump on meeting_rooms (see migration 0008).
--
-- Idempotent: IF NOT EXISTS throughout; safe to run once via the
-- Dashboard SQL Editor, after migrations 0001–0008. No existing rows
-- are modified (every row keeps published_rank NULL until its room's
-- next publish).
-- ---------------------------------------------------------------------------

alter table public.candidate_spots
  add column if not exists published_rank integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'candidate_spots_published_rank_check'
  ) then
    alter table public.candidate_spots
      add constraint candidate_spots_published_rank_check
      check (published_rank is null or published_rank between 1 and 5);
  end if;
end
$$;

comment on column public.candidate_spots.published_rank is 'Rank (1..5) of this spot in the latest published batch, or NULL when not in the latest batch. Owned by the publish-results Edge Function; a re-publish supersedes the previous batch.';
