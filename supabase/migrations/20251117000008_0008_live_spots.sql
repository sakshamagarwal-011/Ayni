-- MeetSync 3D — 0008: live published spots
-- ---------------------------------------------------------------------------
-- Supports publishing live engine results (Photon/Overpass places) as
-- votable candidate_spots (see the publish-results Edge Function):
--
-- * candidate_spots.osm_id — the OSM identity ('node/123', 'way/456',
--   'relation/789') of a published live place. NULL for the seeded
--   demo spots (create-room never sets it) and for any legacy row.
--   A partial unique index on (room_id, osm_id) WHERE osm_id IS NOT
--   NULL makes the OSM identity the dedup key: re-publishing the same
--   place updates its row instead of duplicating it, so votes (which
--   reference spot ids) are never stranded by a duplicate row. The
--   partial index never conflicts on the NULL rows.
--
-- * NO new provenance column: candidate_spots.source already carries
--   it. Seeded spots use source 'default' (create-room), demo-mode
--   spots use 'mock', and published live spots use 'live'. The
--   frontend renders rating/price/open-now only for 'mock'/'default'
--   rows and shows a "Live place" badge for 'live' rows — live places
--   have no rating/price/opening data, and none is invented.
--
-- * NO RLS changes: writes stay Edge-Function-only (service-role
--   client), exactly like create-room seeding. Members already have
--   SELECT on candidate_spots, so published spots are readable by
--   the whole room with no policy change.
--
-- * NO Realtime publication change: candidate_spots is deliberately
--   NOT in the supabase_realtime publication. Propagation rides the
--   decision_version bump on meeting_rooms (which IS subscribed):
--   publish-results increments decision_version, every open page
--   refetches the full room detail — including spots — on the room
--   change event. Adding candidate_spots to the publication would
--   double-notify for the same change.
--
-- * rating / price_level / open_now stay NOT NULL with defaults:
--   published rows store placeholder values (0 / 1 / false) that the
--   frontend must never render for source 'live' (see above). Making
--   the columns nullable would ripple through every spot mapper and
--   display; the source-gated rendering is the honest boundary.
--
-- Idempotent: IF NOT EXISTS throughout; safe to run once via the
-- Dashboard SQL Editor, after migrations 0001–0007. No existing rows
-- are modified (seeded rows keep osm_id NULL and source 'default').
-- ---------------------------------------------------------------------------

alter table public.candidate_spots
  add column if not exists osm_id text;

create unique index if not exists candidate_spots_room_osm_unique
  on public.candidate_spots (room_id, osm_id)
  where osm_id is not null;

comment on column public.candidate_spots.osm_id is 'OSM identity (node/way/relation + id) of a live place published by the publish-results Edge Function. NULL for seeded demo spots. Unique per room (partial index) so re-publishing updates instead of duplicating.';
comment on column public.candidate_spots.source is 'Provenance: default = seeded demo spots, mock = demo-mode spots, live = published from a live engine search. Rating/price/open-now values are meaningful only for default/mock rows; live rows store placeholders that must never be rendered.';
