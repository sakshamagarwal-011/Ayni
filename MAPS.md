# Maps — Ayni Phase 3

Phase 3 adds interactive maps with a free, open-source stack. **No paid
maps provider, no API keys, and no billing are required for the default
development setup.**

- **Rendering:** MapLibre GL JS (BSD-licensed fork of Mapbox GL JS)
- **Tiles/style:** OpenFreeMap Liberty — OpenStreetMap-based vector tiles
- **Geolocation:** Browser Geolocation API (permission-gated, gesture-only)
- **Location storage + sync:** Supabase (existing Phase 2 code, unchanged)
- **Routing (development):** OSRM public demo server, opt-in only
- **Geospatial utilities:** Turf.js (`@turf/bbox`, `@turf/center`, `@turf/helpers`)

Existing screens, routes, Supabase migrations, and Edge Functions are
unchanged in structure. Maps are additive sections inside the existing
page containers; the layout was deliberately left alone (the layout
owner updates it separately).

## Architecture

```
Pages (existing, layout preserved)
  Landing*  Create/Join  Lobby  RouteDiscovery  SpotComparison*  FinalNavigation
      │          │          │           │               │                  │
      │     LocationPicker │     MeetingMap + RouteLegend (map sections only)
      │     (new "Pick      │           │
      │      on map" tab)   │     useMapRoutes (one spot + one mode only)
      │          │          │           │
      └──────────┴──────────┴───── MeetingMap (src/components/map/) ───────┘
                                        │  MapLibre GL JS (single component)
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
     src/map/config.ts         src/map/style.ts          src/map/routing.ts
     (providers, env)          (vector style +           (OSRM client: queue,
                                raster fallback,          cache, fallback)
                                3D buildings)
              │                         │
     src/map/geo.ts (Turf: bounds/centre/expiry)
     src/map/useGeolocation.ts (permission-gated GPS)
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
     OpenFreeMap tiles          OSRM demo server          Supabase (Phase 2)
     (vector, no key)           (opt-in, throttled)       (locations + Realtime)
```

\* Landing has no map (unchanged). SpotComparison has no full map by
design — the voting layout is preserved; it labels spots as demo data
and points at Route Discovery for the map.

### Module map

| File | Responsibility |
|---|---|
| `src/map/config.ts` | All provider choices, env-driven, safe defaults. Pure parser, unit-tested. |
| `src/map/style.ts` | Vector style handling, raster fallback style, 3D-building detection/layer. Type-only MapLibre import (testable in Node). |
| `src/map/routing.ts` | OSRM client (serial queue, cache, timeout, fallback) + pure parsing/label helpers. |
| `src/map/geo.ts` | Turf helpers: bounds, centre, straight-line geometry, expiry checks. |
| `src/map/useGeolocation.ts` | Browser Geolocation hook + error-message helper. |
| `src/map/useMapRoutes.ts` | Per-screen route fetching for one spot + one mode; mock/OSRM/off dispatch. |
| `src/components/map/MeetingMap.tsx` | The one MapLibre component: markers, pins, routes, 3D, camera, fallbacks. |
| `src/components/map/RouteLegend.tsx` | Text route list with distance/time + honest source labels. |

Routing is intentionally **not** a `RoomService` method: OSRM is a
public development routing endpoint, not Supabase data. Location
storage, membership, and Realtime sync stay in the `RoomService` layer;
`useMapRoutes` only turns already-loaded coordinates into drawable
lines. `RouteEstimate` gained optional `geometry`/`source` fields only,
so existing services and tests keep working.

## Provider configuration

All variables are optional. Defaults work with zero new env vars
(OpenFreeMap style + mock/demo routing, no OSRM calls at all).

| Variable | Default | Meaning |
|---|---|---|
| `VITE_MAP_STYLE_URL` | `https://tiles.openfreemap.org/styles/liberty` | MapLibre style JSON URL (any compatible style works). |
| `VITE_MAP_RASTER_FALLBACK_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Raster tiles used only if the vector style fails. |
| `VITE_ROUTING_PROVIDER` | `mock` | `osrm` (live dev routing), `mock` (demo estimates, no network), `off` (no route lines). |
| `VITE_ROUTING_ENABLED` | `true` | Master switch; `false` disables route lines entirely. |
| `VITE_OSRM_BASE_URL` | `https://router.project-osrm.org` | OSRM endpoint. Point at a self-hosted instance for production. |
| `VITE_OSRM_MIN_INTERVAL_MS` | `1100` | Minimum gap between OSRM request starts. Floored at 1000ms against the default demo server (a typo must never disable throttling there); only lower for your own server. |
| `VITE_OSRM_TIMEOUT_MS` | `10000` | Per-request timeout. |
| `VITE_OSRM_CACHE_TTL_MS` | `600000` | In-memory route cache TTL (10 min). `0` means "never expire" — set deliberately only. |
| `VITE_MAP_3D_ENABLED` | `true` | Master switch for 3D building extrusion: `false` disables the layer and the toggle, not just the initial state. |

See `.env.example` for a commented copy-paste block. Invalid values
fall back to defaults with a dev-only `console.warn` naming the
variable (see `mapConfigWarnings` and `tests/unit/mapConfig.test.ts`).

## Tile / style provider: OpenFreeMap

- **Default style:** OpenFreeMap **Liberty** (`https://tiles.openfreemap.org/styles/liberty`).
  OpenStreetMap-based vector tiles in the OpenMapTiles schema, served
  as a MapLibre style JSON. No account, no API key, no published
  request cap. The style JSON was verified to load on 2026-11-17 and
  declares the `openmaptiles` vector source (including the `building`
  source-layer used for 3D extrusion).
- **Attribution:** `© OpenMapTiles © OpenStreetMap contributors`, shown
  via MapLibre's `AttributionControl` on every map. Never strip it.
  OpenStreetMap data is published under the ODbL.
- **Limits / honesty:** OpenFreeMap is donation-funded with **no uptime
  guarantee**. It is suitable for development and low-traffic use; do
  not treat it as unlimited production infrastructure. Offline bulk
  downloads are limited by the provider (see openfreemap.org). This
  app fetches only the tiles for the visible viewport at normal zoom
  levels (max zoom 19) — no prefetching, no bulk downloads.
- **Why not CARTO:** CARTO basemaps used outside the CARTO platform
  have required a free API key since Aug/Sep 2026, and keyless tiles
  are watermarked. That breaks the zero-key default, so CARTO is not
  the default. You can still use a CARTO style by setting
  `VITE_MAP_STYLE_URL` to a CARTO style URL (with your key appended
  per CARTO's instructions) — the config makes this a one-line change.
- **Other OpenFreeMap styles:** `bright`, `positron`, `dark`, and
  `fiord` are published under the same base path
  (`https://tiles.openfreemap.org/styles/<name>`). Swap via
  `VITE_MAP_STYLE_URL`. The `dark` style may suit this app's dark
  theme; it was not the default because Liberty is the provider's
  flagship/documented style — verify any alternative in your own
  browser before committing to it.
- **Raster fallback:** if the vector style fails to load, the map
  retries once with a built-in raster style using standard
  OpenStreetMap tiles (`tile.openstreetmap.org`, max zoom 19) and shows
  a notice. OSM's Tile Usage Policy permits light use only — no heavy
  use, no bulk downloading, valid HTTP User-Agent (browsers supply
  one). The fallback exists so a failed style never leaves a blank
  page; it is not a production tile strategy.
- **Production:** self-host tiles (TileServer GL, Martin, Protomaps)
  or use a hosted provider with an appropriate plan, and point
  `VITE_MAP_STYLE_URL` at it. No code changes needed.

## Routing: OSRM (development only)

- **Endpoint:** `https://router.project-osrm.org` (FOSSGIS-sponsored
  demo server, worldwide car/foot profiles). **Opt-in only:**
  set `VITE_ROUTING_PROVIDER=osrm`. The default (`mock`) makes zero
  OSRM requests.
- **Usage policy (demo server):** reasonable, non-commercial use only;
  **do not exceed 1 request per second**; no uptime, latency, or data
  freshness guarantees; no heavy use, no scraping. This app complies
  by design — see below. The policy text is published by the OSRM
  project (Demo server wiki page); re-check it before relying on the
  demo server for anything beyond local development.
- **Profiles:** `car → driving`, `walk → foot`,
  `scooter → driving`. Scooter means two-wheeler (user choice; there
  is no bicycle mode). The demo server has **no motorcycle profile**,
  so scooter routes on the driving profile — the closest available.
  Never label scooter results as motorcycle-specific routing.
  **Transit has no OSRM profile:** transit requests use the driving
  profile and are labelled as an approximation in the UI
  ("driving profile — no transit routing"). Never present them as
  transit times.
- **Requests:** `GET /route/v1/{profile}/{lng},{lat};{lng},{lat}?overview=full&geometries=geojson&steps=false`
  (GeoJSON geometry for drawing; no turn-by-turn steps fetched).
- **Throttle/cache design** (`src/map/routing.ts`):
  - Serial promise queue: max 1 request in flight, minimum **1100ms**
    between request starts (default; configurable for self-hosted
    servers via `VITE_OSRM_MIN_INTERVAL_MS`).
  - In-memory cache keyed by coords rounded to 5 decimals (~1m) +
    profile, 10-minute TTL, 200-entry cap. Cache hits skip the queue
    entirely. Only OSRM successes are cached; fallbacks are not, so a
    recovered server is retried promptly.
  - 10s timeout per request (AbortController), single attempt, no
    retries.
  - Circuit breaker: after 3 consecutive failures the client fails
    fast for 30s instead of issuing requests that will hang/time out
    one by one through a whole batch. A manual cache clear resets it.
    The optimization engine additionally enforces a 5-minute overall
    routing deadline per search (remaining pairs count as failures
    and are reported, never silently dropped).
  - Screens fetch only what is visible: the selected spot + selected
    mode (max ~4 requests per screen, usually cached). Never all
    participant × spot × mode combinations.
  - On 429/5xx/network error/timeout/malformed payload: the affected
    route falls back independently to the deterministic haversine
    estimate with a straight-line geometry, labelled
    "Estimated — OSRM unavailable". The UI never blocks on routing.
- **At the limit:** if the demo server rate-limits or goes down, maps
  keep working with estimated routes and an honest label. If you hit
  limits repeatedly, self-host OSRM (Docker images published by the
  OSRM project) or switch to another OSRM-compatible endpoint and set
  `VITE_OSRM_BASE_URL`. For other routing engines (Valhalla,
  GraphHopper, openrouteservice), implement a new client behind the
  same `RouteGeometry` type — pages only consume `useMapRoutes`.
- **Privacy:** routing requests send the two endpoint coordinates to
  the configured OSRM endpoint (required to compute a route) and
  nothing else — no names, no room IDs, no auth tokens. Coordinates
  sent to the public demo server are visible to its operator; for
  sensitive use, self-host. See also Privacy below.

## Geolocation + privacy

- **Browser Geolocation API only** (`navigator.geolocation`). No
  third-party geolocation service, no IP geolocation.
- Location is requested **only from an explicit button press**
  ("Use my GPS location"), never on page load, never polled. The
  permission state is checked via `navigator.permissions.query`
  where supported; a denied permission shows guidance + the
  map-pin/coordinate fallbacks instead of re-prompting.
- `watchPosition` exists in the hook for explicit opt-in only; no
  screen currently uses it, and there is no background tracking.
- A GPS fix only fills the form / updates the location when the user
  confirms (form submit, or Save in the lobby). Sending a location to
  Supabase reuses the existing Phase 2 flow (`updateLocation` Edge
  Function, membership-checked, RLS-enforced); the **2-hour expiry**
  is unchanged, and expired locations render dimmed with an "expired"
  note on the map instead of being treated as current.
- Tile servers see normal tile requests (viewport + zoom, no
  participant data). The OSRM endpoint sees route endpoint
  coordinates only (above). No location data is sent to any maps
  provider beyond what routing/tiles inherently require.
- Accuracy: GPS fixes use `enableHighAccuracy: true`, 10s timeout,
  30s maximum age. Accuracy (metres) is shown to the user when the
  browser reports it; the pin can be dragged to correct it.

## Realtime location sync

Unchanged Phase 2 plumbing, reused by the map:

1. A participant updates their location (GPS/pin in the lobby, or
   joining with a location). The write goes through the
   `update-location` Edge Function (JWT + membership verified).
2. Supabase Realtime (`postgres_changes` on `participants` /
   `meeting_rooms`) notifies other browsers in the room.
3. `useRoomDetail` refetches the room; `MeetingMap` receives the new
   `participants` array as props and updates marker positions in
   place (signature-checked, no map recreation, no camera fight —
   refits happen only on explicit fit requests / spot changes).
4. Expired locations (2h) are dimmed and labelled; the cleanup
   function deletes them server-side (see SUPABASE.md).

In Demo mode there is no Realtime channel; the map shows demo
locations with a "Demo data" badge and the "Demo — no live updates"
status. Live two-browser map sync is a **pending manual test**
(TESTING.md §5.8) — it has not been run in this environment.

## Map behaviour

- **Markers:** one per participant with a location (coloured circle
  with initials + name/label/updated-time popup; expired locations
  dimmed). Spot pins are a distinct shape (violet pin, selected state
  with ring). Colour is never the only differentiator: initials,
  names, and text lists carry the same information.
- **Manual pin:** draggable pin + click-to-place in picker mode
  (LocationPicker map tab, lobby pin editing). Keyboard users keep the
  preset/coordinate tabs as full alternatives.
- **Auto-fit:** Turf `bbox` over participants + spots (+ pin) on first
  load. When the screen's fit key changes (spot/mode change), the map
  reframes on participants + the SELECTED spot only
  (`fitPointsForSelection` in `src/map/geo.ts`) — far-away unselected
  spots never widen the viewport. The "Fit all" button always frames
  everything. Never refits on Realtime ticks. Max zoom 15 guard.
- **Routes:** one GeoJSON line layer per map (features coloured per
  participant), casing + animated marching-ants dash via
  `requestAnimationFrame`. Animation pauses when the tab is hidden
  and is disabled entirely when `prefers-reduced-motion` is set
  (static solid lines). Every route's distance/time/source also
  appears as text (RouteLegend + existing page lists).
- **3D buildings:** on style load, if the style exposes a vector
  `building` source-layer, a `fill-extrusion` layer is added before
  the first label layer (heights from `render_height`/`height`, base
  from `render_min_height`/`min_height`, opacity ramping with zoom).
  A "3D buildings" toggle switches it on/off; on styles without
  building data (e.g. the raster fallback) the toggle is disabled
  with an "unavailable" note. All guarded so a missing layer never
  breaks the map.
- **Camera:** pitch buttons (0°/45°/60°), bearing reset ("Reset
  north"), "Fit all", zoom via the standard navigation control,
  smooth `flyTo` when the selected spot changes (Final Navigation),
  touch gestures enabled. User interaction interrupts camera
  animation.
- **Failure modes:** no WebGL → text list of locations. Style load
  failure → one automatic raster-fallback attempt, then an error
  panel with Retry + the same text list. The map never crashes its
  page: initialisation is wrapped in try/catch and all layer/marker
  operations are guarded.

## Mock / demo labelling

- Demo-mode badge in the header (existing) + "Demo data" badges on
  map sections and the route legend in Demo mode.
- "Demo spot" tags on spots whose `source` is `mock` (Demo mode) or
  `default` (Supabase-seeded demo venues in rooms created before
  v0.7.3; new rooms start empty — see `SpotCard`).
- Route labels: "OSRM route (development)", "Estimated — OSRM
  unavailable", "Demo estimate — straight-line". Mock/estimated data
  is never presented as live/real. See `describeRouteSource` in
  `src/map/routing.ts`.

## Switching providers (summary)

| Swap | How |
|---|---|
| Different vector style/tiles | Set `VITE_MAP_STYLE_URL` (any MapLibre style JSON). Self-host with TileServer GL / Martin / Protomaps for production. |
| Different raster fallback | Set `VITE_MAP_RASTER_FALLBACK_URL` (`{z}/{x}/{y}` template). |
| Self-hosted OSRM | Run OSRM (Docker), set `VITE_OSRM_BASE_URL` + `VITE_ROUTING_PROVIDER=osrm`. Optionally lower `VITE_OSRM_MIN_INTERVAL_MS` for your own server. |
| Another routing engine | New client returning `RouteGeometry`, wired in `useMapRoutes`. Keep the throttle/cache/fallback discipline. |
| No routing at all | `VITE_ROUTING_PROVIDER=off` or `VITE_ROUTING_ENABLED=false`. |
| Places source (engine) | Set `VITE_OVERPASS_URL` to a self-hosted Overpass/mirror. See ENGINE.md. |

## Optimization engine + animated routes (Phase 4)

The smart meeting-point engine and premium route animation are
documented in **[ENGINE.md](ENGINE.md)**. Summary for map readers:

- **Places:** Overpass API (OpenStreetMap data, opt-in via
  `VITE_PLACES_PROVIDER=overpass`); mock spots by default. One
  sequential request per search area (max 3), cached, one retry on
  429/504.
- **Routing for ranking:** the same OSRM client as above, in strict
  mode (`fetchRouteStrict`): failures are `null`, never straight-line
  fallbacks. Per-run budget (default 60 pairs) aborts instead of
  truncating.
- **Animation:** `MeetingMap` accepts optional progressive-animation
  props (routes + controlled progress + visibility + pulse +
  immersive 3D). The dash animation is unchanged for callers without
  them. Playback state lives in `useRouteAnimation` and is
  independent of routing. Immersive 3D is MapLibre pitch + building
  extrusion, capability-checked via `canUseImmersive3D()`, with a 2D
  fallback note. No proprietary 3D API is used.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Map area shows "Map failed to load" | No network, or the style URL is unreachable/blocked. Check DevTools Network for the style JSON request; try the raster fallback (automatic) or set `VITE_MAP_STYLE_URL` to another style. Retry button re-initialises. |
| Blank/grey map, no error | WebGL disabled or blocked (headless browser, old GPU). The text fallback should appear; enable hardware acceleration / WebGL and reload. |
| Tiles load but no 3D buildings | Style has no `building` source-layer (raster fallback, or a style without buildings). Toggle shows "unavailable" — expected. Zoom to 15+ in a city area on the vector style. |
| Routes show "Estimated — OSRM unavailable" | OSRM demo server down/rate-limited, or `VITE_ROUTING_PROVIDER` is not `osrm`. Check the Network tab for `router.project-osrm.org` responses (429/5xx). Wait and refresh (cache-busting via the legend refresh is not needed — fallbacks are not cached). |
| Routes are slow to appear (OSRM mode) | Expected: ~1.1s spacing between requests by policy (up to ~4.4s for 4 uncached routes). Repeat visits are cached. For faster routing, self-host OSRM. |
| GPS button does nothing / denied | Browser permission denied or insecure context (Geolocation requires HTTPS or localhost). Allow location in browser site settings, or use the map pin / coordinates. |
| Markers don't move in the other browser | Realtime not enabled (SUPABASE.md step 6), or Demo mode (no live updates by design). See TESTING.md §5.8. |
| `prefers-reduced-motion` | Route lines render static by design. Nothing is broken. |

## Production recommendations

1. **Tiles:** self-host or use a hosted provider with an SLA; keep
   attribution visible; confirm the provider's terms for your traffic.
2. **Routing:** self-host OSRM (or Valhalla) — the public demo server
   is not production infrastructure. Keep the throttle/cache/fallback
   code as a safety net even for self-hosted endpoints.
3. **Privacy review:** decide whether participant coordinates may
   leave your infrastructure for routing; if not, self-host routing
   alongside tiles.
4. **Monitoring:** watch for 429s from any shared endpoint; the
   fallback path keeps the app usable, but repeated fallbacks mean
   the provider choice needs revisiting.
