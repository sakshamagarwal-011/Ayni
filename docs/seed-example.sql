-- docs/seed-example.sql — OPTIONAL, MANUAL ONLY. Never auto-applied.
-- ---------------------------------------------------------------------------
-- This snippet shows how a developer could seed ONE demo room directly in
-- SQL for local experimentation. Do NOT run it in production, and do NOT
-- move it into supabase/migrations/ (migration 0004 documents the
-- seed-free rule). Prefer the in-app Demo mode or the create-room Edge
-- Function, which seeds the same three spots server-side.
--
-- Replace <ROOM_UUID> / <AUTH_UID> with real UUIDs before running.
-- ---------------------------------------------------------------------------

-- insert into public.meeting_rooms (id, invite_code, title, host_auth_uid, status)
-- values ('<ROOM_UUID>', 'K7M2QX', 'Weekend Brunch Meetup', '<AUTH_UID>', 'lobby');
--
-- insert into public.candidate_spots (room_id, name, category, address, lat, lng, rating, price_level, open_now, source)
-- values
--   ('<ROOM_UUID>', 'The Blue Bean Café', 'Café', '100 Ft Road, Indiranagar, Bengaluru', 12.9698, 77.6410, 4.6, 2, true, 'manual'),
--   ('<ROOM_UUID>', 'Violet Gardens Rooftop', 'Restaurant', 'Church Street, MG Road, Bengaluru', 12.9753, 77.6063, 4.4, 3, true, 'manual'),
--   ('<ROOM_UUID>', 'Central Brew House', 'Brewery & Kitchen', 'Residency Road, Bengaluru', 12.9605, 77.6029, 4.2, 2, false, 'manual');

select 'seed-example.sql is documentation only — all statements are commented out.' as notice;
