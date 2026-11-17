# Optimization engine — MeetSync 3D

The smart meeting-point engine ranks **real places** by **road travel
time** for everyone in the room. It is open-source only: places come
from OpenStreetMap data via the Overpass API, road routes come from
OSRM, and maps render with MapLibre. No proprietary places/routing
provider, no API keys, and no billing are required.

The user explicitly chose this open-source design over a proprietary
maps provider. The table below records how each step of the original
10-step brief maps to its open-source equivalent.

## 10-step mapping (brief → open-source implementation)

| Step | Brief (proprietary) | This implementation |
|---|---|---|
| 1. Validate | Membership, consent, coordinates, meeting state | `src/engine/validation.ts` — typed issues, no untyped throws |
| 2. Search areas | Participant geographic distribution | `src/engine/searchAreas.ts` — Turf centre + median-distance circles |
| 3. Discover places | Proprietary Places API | Overpass API (`src/engine/places.ts` + `placesClient.ts`) |
| 4. Deduplicate | Place ID | OSM type+id (`node/…`, `way/…`, `relation/…`), invalid places dropped |
| 5. Travel times | Proprietary Routes API | OSRM `/route` (`src/map/routing.ts`, strict mode) |
| 6. Batches + limits | Compatible request batches, API limits | Profile-grouped, deduplicated, serial 1 req/s queue + per-run budget |
| 7. Unreachable | Exclude unreachable candidates | `src/engine/ranking.ts` — any required participant unreachable/missing |
| 8. Strategies | Min-total, minimax, balanced | `src/engine/scoring.ts` — exact formulas below |
| 9. Constraints | Max travel-time constraints | `src/engine/ranking.ts` — any required duration over the cap excludes |
| 10. Rank + explain | Top 5 + per-participant estimates + explanation | `src/engine/ranking.ts` + `OptimizationPanel` UI |

3D/visualization mapping: proprietary 3D maps → MapLibre immersive 3D
(pitched camera + `fill-extrusion` buildings, capability-checked, 2D
fallback). See "Animated visualization" below.

## Architecture

```
RouteDiscovery ── OptimizationPanel ── runOptimization (orchestrator)
                                          │  Steps 1–10, injected deps
        ┌─────────────────┬───────────────┼──────────────────┐
        │                 │               │                  │
  validation.ts    searchAreas.ts    placesClient.ts    routing (strict)
  (pure)           (pure, Turf)      (Overpass, cached,  (OSRM client,
                                       retried once)     queue/cache)
        │                 │               │                  │
        └─────────────────┴─────── ranking.ts ───────────────┘
                                (score/rank/explain, pure)
                                          │
                                   Top 5 + excluded + warnings

FinalNavigation ── useRouteAnimation + RouteAnimationControls ── MeetingMap
                   (playback state, routing-independent)   (progressive
                                                            reveal, pulse,
                                                            labels, 3D)
```

### Module map

| File | Responsibility |
|---|---|
| `src/engine/types.ts` | Input/result/origin/candidate/travel types. |
| `src/engine/errors.ts` | Typed errors (`code` + `userMessage`), never untyped strings. |
| `src/engine/validation.ts` | Step 1: membership, consent, coords, freshness, state, time, enums. |
| `src/engine/searchAreas.ts` | Step 2: 1–3 deterministic search circles (Turf). |
| `src/engine/scoring.ts` | Step 8: mean/max/population-stddev + the three strategy scores. |
| `src/engine/ranking.ts` | Steps 7/9/10: exclusions, stable sort, top 5, explanations. |
| `src/engine/places.ts` | Steps 3–4 (pure): Overpass QL builder, response parser, dedup. |
| `src/engine/placesClient.ts` | Overpass HTTP client (cache, in-flight dedup, 1 retry, timeout, endpoint fallback) + mock client. |
| `src/engine/orchestrator.ts` | Steps 1–10 in order + pre-filter + budget + live/demo path separation. |
| `src/engine/config.ts` | Engine env vars + `resolveEngineMode()` (live needs BOTH providers). |
| `src/engine/animation.ts` | Pure reveal/decimation/duration helpers. Routing-independent. |
| `src/components/OptimizationPanel.tsx` | Search controls + consent + top-5 results UI (Route Discovery). |
| `src/components/map/useRouteAnimation.ts` | Playback state (rAF, reduced-motion, visibility, 3D toggle). |
| `src/components/map/RouteAnimationControls.tsx` | Play/pause/replay/speed/progress/visibility/3D controls. |
| `src/components/map/MeetingMap.tsx` | Animated layers, pulse marker, labels, immersive 3D (extended, not rewritten). |

The pure core (`types`, `errors`, `validation`, `searchAreas`,
`scoring`, `ranking`, `places`, `animation`) has **no fetch, no
window, and no Supabase imports**. The impure layer
(`placesClient`, `orchestrator`, `config`) takes injected
dependencies so the full flow runs in tests against mocked responses.

## Scoring formulas (Step 8)

Durations are the **required** participants' road times in minutes.
Lower is better for every strategy.

- **Minimum total:** `score = Σ durations`
- **Minimax (fairness):** `score = max(durations)` — minimise the worst
  trip. Ties break by lower total, then lower spread, then name.
- **Balanced:** `score = 0.4 × average + 0.4 × maximum + 0.2 × stdDev`
  where stdDev is the **population** standard deviation,
  `sqrt(mean((x − mean)²))`.

Worked example — durations 10, 20, 30 minutes:

- average = 20, max = 30, stdDev = sqrt((100 + 0 + 100) / 3) ≈ 8.165
- minTotal = 60
- minimax = 30
- balanced = 0.4×20 + 0.4×30 + 0.2×8.165 = 8 + 12 + 1.633 ≈ **21.633**

Ranking tie-breaks (all strategies): score, then max, then total,
then spread (stdDev), then candidate name (alphabetical). The top 5
are returned; the rest are neither ranked nor "excluded" — only true
exclusions (unreachable / over-limit) appear in the excluded list,
with reasons.

## The straight-line boundary (read this before changing the engine)

Straight-line (haversine) distance is used in exactly two places, and
neither is a travel time:

1. **Search-area geometry** (`searchAreas.ts`): sizing circles around
   the group centre.
2. **Pre-filter ordering** (`orchestrator.ts`): when discovery returns
   more candidates than the routing budget allows, candidates are
   ordered by worst straight-line distance and only the nearest
   `maxCandidates` are routed. This limits API calls; it never affects
   the final order, which uses OSRM durations only. The pre-filter is
   recorded in the result warnings whenever it runs.

It is also used to position the animation reveal along a drawn line
(`animation.ts` segment interpolation) — presentation only.

Everywhere else, a missing road route means `reachable: false`, and a
candidate unreachable for a required participant is excluded. In the
live path there is **no** straight-line fallback for travel times. If
all live route requests fail, the run throws `EngineUnavailableError`
and returns no ranked results.

## Providers, limits, and budgets

### Photon (places) — recommended live default as of 2026-11-17

- Why: live testing (2026-11-17) proved browsers on cloud/datacenter
  networks cannot query Overpass directly (overpass-api.de rejects
  them with HTTP 406, the small mirrors time out server-side), and
  the Supabase proxy cannot reach Overpass either (HTTP 502 from
  Supabase's network). Photon category search was verified live in a
  browser on the same day — `include=osm.amenity.cafe` + bbox returns
  real cafés regardless of name, and `include=osm.railway.station`
  finds metro stations — so Photon is the working live places path.
  Enable with `VITE_PLACES_PROVIDER=photon` (plus
  `VITE_ROUTING_PROVIDER=osrm` for live mode); the panel badge reads
  "Live · Photon + OSRM". The direct `overpass` and `proxy`
  providers are unchanged and remain available for self-hosters;
  there is no cross-provider fallback.
- Default endpoint: `https://photon.komoot.io` (public instance,
  shared infrastructure). Override with `VITE_PHOTON_URL`
  (self-hosted Photon) for anything beyond light development use.
- Mechanism: Photon categories carry only the main OSM tag
  (`osm.<key>.<value>`), so each meeting category maps to one or
  more `include` values (see `PHOTON_INCLUDE_CATEGORIES` in
  `src/engine/photonClient.ts`). ONE GET request is issued PER
  include-category, strictly sequentially — verified live:
  comma-combined include values do NOT mix; one category dominates
  the results. Each request is a category-only search (no `q`
  word): `GET {base}/api/?include=<cat>&bbox=<west>,<south>,<east>,
  <north>&lat=<center>&lon=<center>&limit=<n>&lang=en`, where the
  bbox encloses the search circle (Photon bbox order is
  minLon,minLat,maxLon,maxLat). Per-category limit is
  `max(3, ceil(limit / numCategories))`; results are trimmed back
  to the circle client-side (same honest counting as Overpass).
- Honest approximations: `metroStation` returns ALL railway
  stations (Photon categories cannot distinguish
  `station=subway`/`light_rail`), so stations are labelled
  "Railway station" from their tags, never claimed as metro;
  `teaStall` returns cafés/fast-food in the circle (`cuisine` is a
  secondary tag Photon cannot filter on), labelled "Café"/"Fast
  food" from their tags, never invented as tea stalls.
- Fair use: sequential requests only, minimum 1000ms gap between
  request starts, 15s timeout per request, at most one retry only
  on 429/504 honouring `Retry-After` capped at 30s, 10-minute
  cache (search-parameter key) + in-flight dedup. If ANY category
  request fails (after its retry), the whole search fails with
  `EngineUnavailableError` — a partial category set would silently
  bias the ranking, so no partial results are ever returned. The
  serving endpoint is exposed as `PlacesSearchResult.endpoint` /
  `stats.placesEndpoint` and shown in the panel summary for live
  results ("places via photon.komoot.io").
- Identity/dedup: OSM type+id from `osm_type`/`osm_id` (Photon
  uses single letters N/W/R). Features without finite in-range
  coordinates, without a non-empty name, or without a usable OSM
  identity are dropped (counted). Dedup across categories is
  first-wins. `stats.discovered` counts unique places after dedup.

### Overpass (places)

- Default endpoint: `https://overpass-api.de/api/interpreter`
  (public instance, shared infrastructure). Override with
  `VITE_OVERPASS_URL` (self-hosted Overpass or a mirror) for anything
  beyond light development use. The default endpoint was **not**
  verified live from this environment — see TESTING.md §7 for how to
  verify it.
- Endpoint fallback: if the configured endpoint fails (network error,
  non-2xx including HTTP 406, timeout, or invalid JSON), the client
  tries the built-in mirrors in order —
  `https://overpass.kumi.systems/api/interpreter`, then
  `https://overpass.private.coffee/api/interpreter` — sequentially,
  never in parallel. The configured URL is always tried first and the
  list is deduplicated. This exists because overpass-api.de rejects
  requests from some networks (HTTP 406 from datacenter/cloud egress,
  observed 2026-11-17); residential users are usually unaffected, but
  the search must not fail outright on a rejecting network. If every
  endpoint fails, the run throws `EngineUnavailableError` with the
  last endpoint's error, exactly as a single-endpoint failure did.
  The endpoint that served a search is exposed as
  `PlacesSearchResult.endpoint` / `stats.placesEndpoint` and shown in
  the panel summary for live results.
- Fair use: one sequential POST per search area (max 3 areas), capped
  result counts (default 30/area, max 50), query timeout derived from
  the client timeout (45s default, clamped 5–180s), no polling, no
  parallel area queries. Responses are cached 10 minutes
  (query-string key) and concurrent identical searches share one
  in-flight request. The Overpass client is shared (one instance per
  endpoint/timeout) so the cache actually hits across searches.
- Retries: at most one retry, only on 429/504, honouring `Retry-After`
  capped at 30s.
- Query shape: `node`/`way` per tag filter inside a bounding-box
  filter `(south,west,north,east)` enclosing the search circle,
  `out center <limit>`. Ways contribute their centre point. Relations
  are not queried, and `around` is not used: live testing (2026-11-17)
  proved the `around` + relation shape times out server-side on the
  weak public mirrors, while the bbox shape is far cheaper for them.
  Every clause requires `["name"]` so unnamed elements never consume
  the capped result set; elements without finite coordinates are
  dropped (counted in `stats.invalidRemoved`). Because a bbox covers
  corner areas outside the circle, fetched places are trimmed back to
  the circle client-side (haversine geometry only, never a travel
  time; trimmed places are counted in `outsideCircle` and folded into
  `stats.invalidRemoved`), so ranking never sees a place outside the
  search circle.
- Categories: café, restaurant, bar/pub, park, library, coworking,
  fast food, mall (`shop=mall`), metro station
  (`railway=station` + `station=subway`/`light_rail`), railway
  station (`railway=station`), marketplace
  (`amenity=marketplace`), tea stall (`cafe`/`fast_food` with
  `cuisine=tea`). `any` is the union of all category filters.
- Identity/dedup: OSM type+id. The same place appearing in two
  overlapping areas is routed once. `stats.discovered` counts unique
  places after dedup; `generatedAt` is stamped when the run returns,
  not when it starts.

### Places proxy (Supabase Edge Function)

- Why: live testing (2026-11-17) proved browsers on cloud/datacenter
  networks cannot query Overpass directly — overpass-api.de rejects
  them with HTTP 406, and the small mirrors time out server-side even
  on light bbox queries. Supabase is reachable from every network the
  app runs on, so the `places-search` Edge Function queries Overpass
  server-side and the browser talks only to Supabase. Enable with
  `VITE_PLACES_PROVIDER=proxy` (plus `VITE_ROUTING_PROVIDER=osrm` for
  live mode); the panel badge reads "Live · Places + OSRM". The
  direct `overpass` provider is unchanged and remains available for
  networks that can reach Overpass; there is no
  cross-provider fallback.
- Status (2026-11-17): the function is deployed, but currently
  returns HTTP 502 — Overpass is unreachable from Supabase's network
  too, so the proxy cannot serve searches until that changes. The
  Photon provider (above) is the working live path.
- Contract: the browser sends structured parameters only —
  `{ centerLat, centerLng, radiusKm, category, limit }` — and NEVER
  raw Overpass QL (the function builds the query itself, so it cannot
  be abused to run arbitrary queries). The function validates
  strictly (lat/lng ranges, category allow-list; radius clamped to
  0.5–25 km, limit clamped to 1–50; 400 on invalid input) and returns
  `{ places: [{ osmId, name, category, lat, lng, address? }], dropped,
  duplicatesRemoved, outsideCircle, endpoint }`, where `endpoint` is
  the serving Overpass URL (shown as "places via \<hostname\>" exactly
  like the direct client). On total upstream failure it returns HTTP
  502 `{ error: 'places_unavailable' }` without leaking upstream
  bodies or statuses.
- Auth: a valid user JWT is required (default `verify_jwt = true`;
  401 without one). The function needs NO service-role key and NO
  database access — it only fetches a public API.
- Server-side behaviour mirrors the direct client: the SAME bbox
  query shape (node/way, `["name"]`, `out center <limit>`, QL timeout
  20s), the same parse/drop/dedup rules, and the circle filter applied
  server-side (the browser client re-applies it as defense in depth).
  Endpoints are tried sequentially in the same order
  (overpass-api.de, kumi.systems, private.coffee), 20s per endpoint,
  one retry only on 429/504 honouring `Retry-After` capped at 30s.
  A 200 response carrying a "Query timed out" remark with zero
  elements counts as an endpoint failure (fall through to the next
  endpoint), since that is how weak mirrors report an unanswered
  query; a remark WITH elements is still a usable result.
  Fair-use discipline is unchanged: sequential requests, capped
  result counts, 10-minute client-side cache, in-flight dedup.
- MIRROR WARNING: the function's query builder, category tags, bbox
  math, label logic, and response parsing DUPLICATE
  `src/engine/places.ts` (Deno cannot import the Vite bundle). Change
  one, change the other — see the MIRROR comments in both files.
- Client timeout: 55s (covers the function's worst case). A client
  timeout surfaces the same timeout message as the direct client.
  The function must be deployed (`supabase functions deploy
  places-search`) before `proxy` mode can work — see SUPABASE.md.

### OSRM (routing)

- Reuses the Phase 3 client (`src/map/routing.ts`): serial queue, max
  1 request in flight, 1100ms minimum gap (public demo-server policy),
  10-minute cache, 10s timeout, single attempt. The engine uses the
  **strict** variants (`fetchRouteStrict`), which return `null` on
  failure instead of falling back.
- Batching: (origin, candidate) pairs are deduplicated by rounded
  coords + profile, then grouped by OSRM profile (driving → foot
  order is incidental to sorting; grouping only keeps same-profile
  requests adjacent). Profiles: car → driving, walk → foot,
  scooter → driving (no motorcycle profile on the demo server —
  scooter times are car-profile road times, never labelled
  otherwise), transit → driving (labelled as an approximation —
  OSRM has no transit routing).
- Budget: `VITE_OPTIMIZATION_MAX_OSRM_REQUESTS` (default 60 unique
  pairs). Exceeding it aborts with `EngineQuotaError` **before** any
  routing call — results are never silently truncated. Worst case for
  defaults: 12 candidates × 4 participants = 48 pairs, inside budget.
- **Meeting time:** accepted, validated, and echoed in results, but
  OSRM's demo server has no traffic or departure-time model, so
  durations are static/free-flow. No traffic adjustment is invented.
  The UI states this next to the meeting-time input and in warnings.

### Live vs demo paths (never mixed)

`resolveEngineMode()` returns `live` only when **both**
`VITE_PLACES_PROVIDER=overpass` and `VITE_ROUTING_PROVIDER=osrm`.
Any mixed config falls back to the fully-labelled demo path (mock
places + deterministic estimates). This prevents live places being
ranked with demo times, or mock places being presented as live
results. `VITE_OPTIMIZATION_ENABLED=false`, `places=off`, or
`routing=off` disables the search entirely with an explanatory
message. Defaults (no env vars) are demo: zero external calls.

## Validation, consent, and privacy (Step 1)

- **Membership:** the runner must be a room member and every origin
  must belong to a member. Non-members are rejected by name.
- **Consent:** EVERY origin must have `consentGiven` — required or
  not — because every origin feeds search areas and OSRM routing
  (coordinates leave the browser in live mode). In the UI, the runner
  ticks an explicit checkbox. Other room members consented by sharing
  a location in the room for the purpose of meeting-point search —
  this room consent model is stated in the panel copy and here.
- **Coordinates/freshness:** finite lat/lng in range; expired
  locations (2-hour expiry, same as Phase 2) are rejected and named.
  Required participants without an origin reject the run — locations
  are never defaulted or invented.
- **Meeting state:** only `lobby`, `discovering`, `comparing`. A
  finalized/expired meeting cannot start a new search.
- **Meeting time:** valid ISO, not more than 24h in the past.
- **Constraints:** `maxTravelMinutes` 5–240; `maxCandidates` 1–20.
- **Privacy:** in live mode, Overpass receives search circles
  (centre + radius + category) and OSRM receives route endpoint
  coordinates. No names, room ids, or auth tokens are sent to either
  endpoint. Coordinates sent to public servers are visible to their
  operators; self-host both endpoints for sensitive use. No location
  is written to Supabase by the engine — storage stays in the Phase 2
  flow.

## Failure modes

| Failure | Behaviour |
|---|---|
| Invalid input | `OptimizationValidationError` listing every issue; no network calls. |
| Overpass down / 429 / timeout | `EngineUnavailableError` ("Live place search is unavailable… No estimates shown."); one retry on 429/504 per endpoint, then the next mirror in the fallback list. |
| No places found | `EngineNoPlacesError` naming the category + search area. |
| Some routes fail | Those (participant, candidate) pairs are unreachable; candidates unreachable for a required participant are excluded with reasons. |
| All routes fail (live) | `EngineUnavailableError` ("Live routing is unavailable… No estimates shown."); no ranked results. |
| Budget exceeded | `EngineQuotaError` before any routing call, naming pairs vs limit. |
| Engine disabled / mixed config | Demo path or disabled message — never a silent live-looking result. |

Engine failures never hide the existing Route Discovery content: the
panel shows its own error banner and the demo spot list below stays
visible.

## Animated visualization (Part B)

- **Progressive reveal:** `progressGeometry()` slices each route's
  geometry by travelled length (constant-speed reveal). The map
  writes ghost (full, faint) + progress slices into ONE GeoJSON
  source with a single `setData` per update; geometries are decimated
  to ≤500 points and capped at 4 routes for mid-range Android
  performance.
- **Playback:** `useRouteAnimation` drives progress with
  `requestAnimationFrame` (~30fps state updates), pauses when the tab
  hides, and supports play/pause/replay, 1×/2× speed, seek slider,
  and per-participant visibility toggles. Animation state is
  independent of routing: it consumes geometries only and makes no
  network calls.
- **Camera:** playback starting from 0 fits all visible routes once
  (900ms); any mouse/touch/wheel grab pauses playback via
  `onCameraInteraction`. Existing fly-to/fit/tilt controls are
  untouched.
- **Destination pulse + labels:** a CSS pulse ring at the destination
  (static under `prefers-reduced-motion`) and one midpoint pill per
  visible route ("Name · 24 min · 3.2 km"). Labels are also available
  as text in the legend + travel-times list — the map never carries
  information alone.
- **Immersive 3D:** `canUseImmersive3D()` (pure, in `src/map/style.ts`)
  requires WebGL + a vector style with building data + 3D enabled.
  When supported, enabling it pitches the camera to 60° with a slight
  bearing and turns buildings on (instant `jumpTo` under reduced
  motion, eased otherwise). When unsupported, the toggle is disabled
  with a reason and the map shows a "3D unavailable — showing 2D map"
  note. No proprietary 3D API is used; nothing is faked.
- **Reduced motion:** playback starts paused at full progress, route
  lines render static, the pulse ring is static, and camera moves are
  instant. The controls explain this in the UI.

## Switching providers

| Swap | How |
|---|---|
| Self-hosted Photon | Set `VITE_PHOTON_URL`. No code changes. |
| Self-hosted Overpass / mirror | Set `VITE_OVERPASS_URL`. No code changes. |
| Self-hosted OSRM | Set `VITE_OSRM_BASE_URL` (+ `VITE_ROUTING_PROVIDER=osrm`). Optionally lower `VITE_OSRM_MIN_INTERVAL_MS` for your own server. |
| Another places source | Implement `PlacesClient` (same `search()` shape) and wire it in `OptimizationPanel`. Keep the cache/retry discipline. |
| Another routing engine | Implement `EngineRoutingClient` returning `RouteGeometry \| null` (strict, no fallback) and wire it in `OptimizationPanel`. Keep the throttle/budget discipline. |
| No live search | Leave the defaults (demo path) or set `VITE_OPTIMIZATION_ENABLED=false`. |

## Testing

- Unit: `npm test` — scoring (exact values), validation, search
  areas, Overpass QL/parsing/dedup, Photon category requests/
  parsing/dedup, animation geometry, ranking,
  engine config, immersive-3D capability, strict OSRM mode.
- Integration (mocked APIs): `npm run test:integration` — full
  orchestrator runs against fixture Overpass/OSRM responses:
  happy path, unreachable/max-time exclusion, 429 retry + persistent
  failure, total OSRM failure (no fallback results), dedup, quota,
  profile batching, demo path.
- Live procedure: TESTING.md §7 (real browser + opt-in env vars).
  Live Overpass/OSRM behaviour, GPS flows, and in-browser animation/
  3D rendering are **PENDING** manual verification — not claimed as
  passed.
