# MeetSync 3D

A premium mobile-first group meeting point finder. Create a room, share an invite link, compare fair meeting spots for everyone, vote, and navigate together.

Phase 1 (UI + mock data), Phase 2 (Supabase integration), Phase 3 (open-source maps), Phase 4 (optimization engine + animated routes), and Phase 5 (group coordination: voting, host-only finalization, ETA/navigation, arrival, expiry, reconnect) are delivered as **one coherent codebase**: every page talks to a single `RoomService` interface. When Supabase env vars are present the app uses Supabase + Edge Functions + Realtime; otherwise it runs in clearly-labelled **Demo mode** with local mock data — no env vars required. Maps are additive sections inside the existing screens; the layout was left untouched for later updates.

> **Maps without Google, keys, or billing.** Interactive maps use MapLibre GL JS + OpenStreetMap-based vector tiles (OpenFreeMap), GPS uses the Browser Geolocation API, and live development routing uses OSRM (opt-in). No Google Maps, no Google API keys, no Google Cloud billing, and no paid mapping API. See [MAPS.md](MAPS.md) for providers, limits, and production guidance.

## Stack

- React 18 + TypeScript (strict) + Vite
- Tailwind CSS v3, React Router v6, Framer Motion
- Supabase (`@supabase/supabase-js`, anonymous auth, PostgreSQL, RLS, Realtime, Edge Functions)
- MapLibre GL JS + OpenStreetMap tiles (OpenFreeMap), Turf.js, OSRM for development routing (opt-in), Overpass API for place discovery (opt-in)
- Vitest for unit + integration + RLS tests

## Routes

| Route | Page |
|---|---|
| `/` | Landing |
| `/create` | Create Meeting |
| `/join` | Join Meeting |
| `/join/:code` | Join Meeting (code pre-filled) |
| `/room/:code/lobby` | Meeting Lobby |
| `/room/:code/routes` | Route Discovery |
| `/room/:code/compare` | Spot Comparison (vote) |
| `/room/:code/navigate` | Final Navigation |

The invite code is always in the URL, so meeting links work across browsers and devices. Unknown rooms show an error state with a link to `/join`.

## Project structure

```
src/
  types/        Shared TypeScript types
  data/         Mock data: exactly 4 friends + 3 Bengaluru spots
  lib/          utils, validation, distance (haversine + estimates),
                supabaseClient, useRoomDetail hook
  map/          MapLibre config, styles, OSRM routing client, Turf
                helpers, geolocation hook, per-screen route fetching
  engine/       Optimization engine: pure core (validation, search
                areas, scoring, ranking, Overpass parsing, animation
                geometry) + Overpass client + orchestrator + config
  coordination/ Group coordination: pure state machine, voting/tally,
                ETA, expiry, navigation privacy, arrival, stale guard,
                reconnect helper, typed errors (see COORDINATION.md)
  services/     RoomService interface + mock + supabase implementations
                + service selection (getRoomService)
  components/   Layout, Navbar, SpotCard, ParticipantAvatar,
                LoadingSkeleton, ErrorBanner, LocationPicker,
                OptimizationPanel, RoomBanners,
                map/MeetingMap + map/RouteLegend +
                map/RouteAnimationControls + map/useRouteAnimation
  pages/        7 pages (see Routes above)
supabase/
  migrations/   0001 schema, 0002 RLS, 0003 Realtime + expiry, 0004 no-seed,
                0005 coordination (decision version, arrival, expire_rooms)
  functions/    create-room, join-room, update-location,
                finalize-meeting, places-search,
                cleanup-expired-locations + _shared/
tests/
  unit/         Validation, invite-code, haversine + route-estimate tests,
                map tests, engine tests (scoring, validation, search
                areas, places, animation, ranking, config, strict routing),
                coordination tests (state machine, voting, ETA, expiry,
                stale guard, navigation privacy, arrival, reconnect, errors)
  integration/  Optimization runs against mocked Overpass/OSRM responses;
                coordination flows against two mock services sharing a store
  rls/          Unauthorized-access tests (skipped without test env vars)
docs/           Optional manual seed snippet (never auto-applied)
```

## Setup — Demo mode (no Supabase needed)

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`). The header shows **“Demo mode — Supabase not configured”**. Try the sample room: Join → code `K7M2QX`, or open `/join/K7M2QX`.

Demo flow: Landing → Create → Lobby → Routes → Compare (rank + save vote) → Finalize → Navigate.

Maps need network access to load tiles (OpenFreeMap); without network the map shows an error panel with a text list of locations. Route lines use demo estimates by default (no network calls). To try live OSRM road routes in development, set `VITE_ROUTING_PROVIDER=osrm` in `.env` — see [MAPS.md](MAPS.md) for the demo-server limits first.

## Setup — Supabase mode

See **[SUPABASE.md](SUPABASE.md)** for the full guide: create a project, enable Anonymous auth, run migrations, deploy Edge Functions, set secrets, and enable Realtime. In short:

```bash
cp .env.example .env
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (public anon key only)
npm run dev
```

The header then shows **“Live · Supabase”**. The service-role key is **never** used in browser code — it is an Edge Function secret only.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc --noEmit` + production build |
| `npm run preview` | Serve the production build locally |
| `npm test` | Unit tests (no Supabase needed) |
| `npm run test:maps` | Map-layer unit tests only (config, routing, Turf, styles, geolocation) |
| `npm run test:integration` | Coordination + optimization integration tests against mocked services/responses (no network) |
| `npm run test:rls` | RLS unauthorized-access tests (needs test env vars; skips gracefully without them — see TESTING.md) |
| `npm run test:all` | All tests |

## Testing

- **Unit tests:** `npm test` — invite-code format, validation rules, haversine distance, route estimates, map config, OSRM parsing/throttle/cache, Turf bounds/centre, style fallback, geolocation messages, engine scoring/validation/search-areas/places/animation/ranking/config, strict OSRM mode, immersive-3D capability, coordination state machine/voting/ETA/expiry/stale guard/navigation privacy/arrival/reconnect/errors. Must pass with no env vars and no network.
- **Integration tests:** `npm run test:integration` — full optimization runs against mocked Overpass/OSRM responses (happy path, exclusions, 429/failure handling, dedup, quota, batching, demo path) and coordination flows against two mock services sharing one store (voting replacement, host/non-host finalization, same-destination reads, stale versions, arrival, expiry, stale optimization, mocked-channel reconnect). Must pass with no network.
- **Manual + two-browser checklist:** see **[TESTING.md](TESTING.md)**. The two-browser verification (two independent browser sessions joining the same room) is **PENDING** — it requires a real Supabase project and has not been run in this environment. Do not treat it as passed until someone runs the steps in TESTING.md against a configured project. Map manual tests (including two-browser location sync) are in TESTING.md §5 and are likewise **PENDING**. Engine/animation live tests are in TESTING.md §7 and are likewise **PENDING**. Coordination live tests (voting Realtime, finalize, announcement, navigation privacy, arrival, reconnect, expiry) are in TESTING.md §8 and are likewise **PENDING**.

## Design notes

- **Dark navy** (`#070B1A`) with blue + violet gradients, glass cards, Framer Motion page transitions, mobile-first layouts with safe-area padding.
- **Validation everywhere:** title 3–60 chars, display name 2–30 chars, invite-code format, location required. Inline errors + loading skeletons + error banners with retry.
- **Locations expire after 2 hours** (DB trigger + cleanup Edge Function / pg_cron — see SUPABASE.md).
- **Demo vs Supabase storage:** Demo mode persists rooms in `localStorage` (single-browser demo only). Supabase mode stores no room state in `localStorage` except a display-name draft and last-code hint; room state lives in PostgreSQL and syncs via Realtime.
- **Maps (Phase 3):** one `MeetingMap` component (MapLibre + OpenStreetMap), additive map sections in Lobby / Routes / Navigate, GPS + pin picking in `LocationPicker`. Routing is a separate client-side layer (`useMapRoutes` + OSRM client), not a `RoomService` method. Mock/demo data is labelled in the UI; see [MAPS.md](MAPS.md).
- **Optimization engine (Phase 4):** pure-TypeScript core + Overpass/OSRM clients in `src/engine/`; ranking uses road times only (no straight-line fallback in the live path). See [ENGINE.md](ENGINE.md). Animated route playback (`useRouteAnimation` + `RouteAnimationControls`) is independent of routing and consumes geometries only.
- **Group coordination (Phase 5):** pure coordination layer in `src/coordination/` (state machine, voting/tally, ETA, expiry, navigation privacy, arrival, stale guard, reconnect, typed errors); host-only version-guarded finalization; Realtime on four tables with 300 ms coalescing and bounded reconnect backoff. Navigation links are OpenStreetMap + `geo:` (open-source only, no Google). See [COORDINATION.md](COORDINATION.md).

## Deviations from the original brief

None material. Two clarifications, both documented where they occur:

1. **Spot seeding in Supabase mode:** RLS forbids direct browser inserts into `candidate_spots`, so `create-room` seeds the same three Bengaluru spots server-side (service-role client). Without this, new Supabase rooms would have no spots to compare.
2. **Route estimates in Supabase mode** are computed client-side with the same deterministic formula as Demo mode. The `route_estimates` table exists (with RLS) for future server-computed estimates. Phase 3 adds optional live road routing via OSRM as a separate client-side layer (`useMapRoutes`); it does not write to `route_estimates`.
