# Supabase setup — MeetSync 3D

This guide takes you from an empty Supabase project to a working Live mode. Nothing here requires code changes: set the env vars, run the migrations, deploy the functions, and the app switches from Demo mode automatically.

> **Security rule:** the **service-role key** is used ONLY inside Edge Functions (server-side). It must never appear in `.env` as a `VITE_` variable, in `src/`, or in any browser code. It bypasses Row Level Security.

## 1. Create a project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → New project.
2. Note the **Project URL** and **anon / public key** (Project Settings → API). These become `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in your frontend `.env`.
3. Install the Supabase CLI if you want `supabase db push` / `supabase functions deploy`:
   ```bash
   npm install -g supabase
   supabase login
   supabase link --project-ref <your-project-ref>
   ```

## 2. Enable Anonymous auth

Anonymous auth is how guests join rooms without creating accounts.

1. Dashboard → **Authentication → Providers → Anonymous** → Enable.
2. (Optional) In **Authentication → URL Configuration**, set **Site URL** to your app URL (e.g. `http://localhost:5173` for local dev, your deployed URL for production) and add it to **Redirect URLs** if you later add email/OAuth flows. Anonymous auth itself needs no redirect.

If anonymous auth is disabled, the app shows a clear error: *“Anonymous sign-in failed. Enable Anonymous auth…”*.

## 3. Run the migrations

Migrations live in `supabase/migrations/` and must be applied **in filename order**:

| File | Contents |
|---|---|
| `20251117000001_0001_schema.sql` | Extensions, 6 tables, constraints, indexes, triggers, invite-code generator |
| `20251117000002_0002_rls.sql` | RLS on every table, membership helpers, policies, privilege-change trigger |
| `20251117000003_0003_realtime_expiry.sql` | Realtime publication, location-expiry trigger, cleanup functions |
| `20251117000004_0004_no_seed.sql` | Seed-free guardrail (verifies RLS is enabled; inserts nothing) |
| `20251117000005_0005_coordination.sql` | Coordination: `decision_version` + `finalized_at` on rooms, `arrived_at` on participants, `expire_rooms()`, Realtime adds for `votes` + `participant_locations` |
| `20251117000006_0006_audit_hardening.sql` | Audit hardening: revoke RPC `EXECUTE` on the `SECURITY DEFINER` cleanup/expire functions from `public`/`anon`/`authenticated` (service_role + postgres only); votes validity trigger + unique `(room_id, participant_id, rank)`; atomic `replace_votes()` RPC; expired locations hidden from the member `SELECT` policy |
| `20251117000007_0007_scooter_mode.sql` | Allow `scooter` in the `route_estimates` mode CHECK (`bike` retained only so pre-existing rows stay valid; the app no longer emits it) |
| `20251117000008_0008_live_spots.sql` | Live published spots: nullable `candidate_spots.osm_id` + partial unique index on `(room_id, osm_id)` (dedup key for publish upserts; seeded rows keep NULL). No RLS/Realtime changes — provenance reuses the existing `source` column (`live` vs `default`/`mock`), and propagation rides the `decision_version` bump (see the migration header) |
| `20251117000009_0009_published_rank.sql` | Shared published rank: nullable `candidate_spots.published_rank` + CHECK (null or 1..5, guarded DO block). 1..5 = rank in the latest published batch, NULL = not in the latest batch; owned by `publish-results`, which clears the rank on every other spot in the room so a re-publish supersedes the previous batch. Makes the published ordering shared and server-authoritative (v0.7.1 fix: without it, non-publishers' Compare pages capped at 5 by creation order and published spots beyond the cap were unvotable). No RLS/Realtime changes |

**Option A — Supabase CLI (recommended):**

```bash
supabase db push
```

**Option B — Dashboard SQL editor:** open each file in order, paste, and Run. Confirm no errors before moving to the next file.

Verify RLS afterwards (SQL editor):

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public'
  and tablename in ('meeting_rooms','participants','participant_locations','candidate_spots','route_estimates','votes');
-- rowsecurity must be true for all six rows.
```

## 4. Deploy the Edge Functions

Functions live in `supabase/functions/`:

| Function | Purpose |
|---|---|
| `create-room` | Verify JWT → validate → generate secure invite code → insert room + host + default spots (service role) |
| `join-room` | Verify JWT → normalize code → idempotent participant upsert; expired rooms → 410; finalized rooms joinable for viewing |
| `update-location` | Verify JWT + membership → upsert own location (expires +2h); expired rooms → 410 |
| `finalize-meeting` | Verify JWT + host → optimistic-lock finalize (version guard, 409 stale/already-finalized, 410 expired) |
| `publish-results` | Verify JWT + membership → validate 1–5 live places → upsert `candidate_spots` by `(room_id, osm_id)` (select-then-write; the dedup index is partial so `.upsert(onConflict)` cannot target it) → set `published_rank` 1..N in submitted order and clear it on every other spot in the room (re-publish supersedes the previous batch) → bump `decision_version` (conditional on open status, before the spot writes) → return spots + new version. 30-spot room cap (409 `SPOT_LIMIT`). Requires migrations 0008 + 0009. Deploy with: `supabase functions deploy publish-results` |
| `places-search` | Verify JWT → structured place search → build Overpass QL server-side → sequential endpoint fallback → parse/dedup/circle-filter → return places. No service-role key, no database access. Required for `VITE_PLACES_PROVIDER=proxy` (see ENGINE.md). Status 2026-11-17: deployed, but currently returns 502 — Overpass is unreachable from Supabase's network too; use `VITE_PLACES_PROVIDER=photon` for live search |
| `cleanup-expired-locations` | Cron-secret auth → delete expired locations + mark expired rooms + prune old rooms (retention configurable) |

Deploy (CLI):

```bash
supabase functions deploy create-room
supabase functions deploy join-room
supabase functions deploy update-location
supabase functions deploy finalize-meeting
supabase functions deploy publish-results
supabase functions deploy places-search
supabase functions deploy cleanup-expired-locations
```

Or deploy all at once: `supabase functions deploy` (from the project root, depending on CLI version).

The shared helpers in `supabase/functions/_shared/` (`cors.ts`, `auth.ts`, `validation.ts`) are imported relatively by each function — no separate deploy needed.

## 5. Set Edge Function secrets

The `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` variables are available to Edge Functions automatically in Supabase-hosted projects. Set the cleanup secret yourself:

```bash
# Generate a long random secret first, e.g. openssl rand -hex 32
supabase secrets set CLEANUP_SECRET=<your-long-random-secret>
# Optional: room-retention window for the cleanup function (days, 1–90, default 7)
supabase secrets set CLEANUP_RETENTION_DAYS=7
```

If you self-host or run functions locally (`supabase functions serve`), set all three explicitly:

```bash
supabase secrets set SUPABASE_URL=<url> SUPABASE_ANON_KEY=<anon> SUPABASE_SERVICE_ROLE_KEY=<service-role> CLEANUP_SECRET=<secret>
```

**Never** commit these values. The service-role key must never be prefixed `VITE_` or placed in frontend `.env`.

## 6. Enable Realtime

Migration 0003 adds `meeting_rooms` and `participants` to the `supabase_realtime` publication; migration 0005 adds `votes` and `participant_locations` (guarded `DO` blocks, safe to re-run). Verify in Dashboard → **Database → Replication**: all four tables should be listed/enabled. If your project predates the migrations, toggle them on there as well.

The frontend subscribes with `postgres_changes` filters (`participants`/`votes`/`participant_locations` by `room_id`, `meeting_rooms` by `id`) on one channel per room, coalesces rapid events with a 300 ms debounce, and resubscribes with bounded exponential backoff (1s/2s/4s/8s, max 5 attempts) on channel errors. Connection status shows in the lobby pill and on every room page, with retry UI on failure. See [COORDINATION.md](COORDINATION.md) §7.

## 7. CORS / site URL

- Edge Functions return `Access-Control-Allow-Origin: *` via the shared CORS helper (appropriate for invite links shared anywhere). Tighten to your domain in `_shared/cors.ts` before production if you prefer.
- Supabase API CORS is managed by the platform; no extra config is needed for browser calls from `localhost` or your deployed origin.

## 8. Frontend env vars

```bash
cp .env.example .env
```

Set only:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-public-key>
```

Restart `npm run dev`. The header badge changes from Demo mode to **Live · Supabase**.

## 9. Invite-link behaviour

- Links look like `https://<your-app>/join/K7M2QX` and lobby URLs like `/room/K7M2QX/lobby`.
- Joining POSTs to the `join-room` Edge Function, then navigates to the lobby. The code in the URL is the only room identifier the frontend needs — no `localStorage`-only room state in Supabase mode (only a display-name draft + last-code hint are cached locally).
- A non-member opening a lobby URL directly sees the “Room not found / join first” error state, because RLS hides non-member rooms. They must join via `/join/:code` first. This is intentional (see migration 0002 threat-model comment).

## 10. Location expiration & cleanup

- Every `participant_locations` row expires 2 hours after its last update (DB trigger in migration 0003). Since migration 0006, expired rows are also invisible to members via RLS (`expires_at > now()` in the `SELECT` policy) — clients read them as "no location" until the member refreshes.
- Expired rows are deleted by **one** of:
  - **Option A (preferred):** Supabase Scheduled Functions invoking `cleanup-expired-locations` every 15 minutes with header `x-cron-secret: <CLEANUP_SECRET>`. Configure in Dashboard → **Edge Functions → Schedules** (or via `supabase functions deploy` + the dashboard cron UI), pointing at the function URL with that header. The function has `verify_jwt = false` in `supabase/config.toml` (a scheduled job has no user JWT); the `x-cron-secret` check inside the function remains the auth — do not remove it.
  - **Option B:** `pg_cron` calling `select public.delete_expired_locations();` — see the commented example in migration 0003. (Option B only deletes locations; it does not mark rooms expired or prune old rooms — prefer Option A.) Migration 0006 grants the cleanup functions to `postgres` so pg_cron callers keep working.
- The cleanup function also marks past-`expires_at` non-finalized rooms `expired` (via `expire_rooms()`, migration 0005; finalized rooms are never auto-expired for display) and prunes expired/finalized rooms whose `expires_at` is older than the retention cutoff — default 7 days, configurable via the `CLEANUP_RETENTION_DAYS` Edge Function secret (1–90). It never deletes non-expired rooms. It returns `{ deletedLocations, expiredRooms, prunedRooms, retentionDays }` for log inspection.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| “Anonymous sign-in failed” | Enable Anonymous provider (step 2). |
| Join returns 404 for a valid code | Migrations not applied, or functions not deployed, or room expired. Check function logs (Dashboard → Edge Functions → Logs). |
| Join returns 410 | The room expired (`expires_at` passed or status `expired`). Create a new meeting. |
| Lobby loads but never updates live | Realtime not enabled for the tables (step 6), or `supabase_realtime` publication missing the tables. Re-run migrations 0003 + 0005. |
| Votes do not update live | `votes` table missing from the Realtime publication — re-run migration 0005 and check step 6. |
| Finalize returns 409 "out of date" | Another decision landed first — reload; the UI refetches and shows the current destination. |
| “Only the host can finalize” | Correct behaviour — finalize from the host's browser/session. |
| Direct table reads return empty in SQL editor as `anon` | Expected: RLS hides non-member rows. Use the service-role / postgres role in the SQL editor to inspect data. |
