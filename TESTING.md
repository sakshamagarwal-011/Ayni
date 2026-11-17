# Testing — MeetSync 3D

## Verification status

| Check | Status |
|---|---|
| Unit tests (`npm test`) | Run locally during development — see command output in the handoff / CI. Must pass with no env vars. |
| Production build (`npm run build`) | Run locally during development — see command output in the handoff / CI. |
| RLS unauthorized-access tests (`npm run test:rls`) | **PENDING** — requires a real Supabase project + test env vars. Not run in this environment (no credentials were invented or used). |
| **Two-browser test (see below)** | **PENDING** — requires a real Supabase project and two independent browser sessions. **Do NOT claim this passed until someone runs it and records the result.** |
| **Phase 3 map manual tests (§5)** | **PENDING** — require a real browser (WebGL, GPS permission flows, network). Not run in this environment (no browser test harness, no credentials). Live OSRM routing and two-browser map sync are **unverified** until §5 is run and recorded. |
| **Engine + animation live tests (§7)** | **PENDING** — require a real browser + opt-in Overpass/OSRM env vars. Not run in this environment. Live place search, live optimization ranking, and in-browser animation/3D rendering are **unverified** until §7 is run and recorded. |
| **Coordination live tests (§8)** | **PENDING** — require a real Supabase project (migration 0005 + redeployed Edge Functions) and two independent browser sessions. Not run in this environment. Live voting Realtime, host/non-host finalize, announcement, navigation privacy, arrival, reconnect, expiry, and stale-optimization behaviour are **unverified** until §8 is run and recorded. |

## 1. Unit tests (no Supabase needed)

```bash
npm install
npm test
```

Covers: invite-code format/normalization, title/display-name/lat/lng validation, haversine distance, deterministic route estimates, mock-data shape (4 friends, 3 spots).

## 2. Demo-mode manual checklist (no env vars)

```bash
npm run dev
```

- [ ] Landing loads; header shows “Demo mode — Supabase not configured”.
- [ ] Create: empty title / short name / missing location show inline errors; valid form creates a room and lands in the Lobby with a 6-char code.
- [ ] Lobby: invite code + copy-link work; participants listed; ready toggle flips; “Discover routes” navigates onward.
- [ ] Routes: mode tabs (Walk/Bike/Car/Transit) change estimates; fairest spot is ranked #1; back/forward navigation works.
- [ ] Compare: up/down reordering works; “Save my ranking” confirms; finalize navigates to Navigate.
- [ ] Navigate: final spot shown with per-friend distance/ETA; external-maps links are present and labelled external; copy-link works.
- [ ] Unknown room: opening `/room/ZZZZZZ/lobby` shows an error state with a link to `/join`.
- [ ] Join: bad code format shows an inline error; code `K7M2QX` (demo room) joins successfully; `/join/K7M2QX` pre-fills the code.
- [ ] Mobile: layout is usable at 360px width; buttons reachable; no horizontal overflow.

## 3. RLS unauthorized-access tests (real project required)

These tests assert that RLS blocks unauthorized reads/writes. They skip gracefully when env vars are absent.

```bash
# Anon-level checks only (no service key needed):
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_ANON_KEY_TEST=<anon-key> \
npm run test:rls

# Full checks (room isolation) — service key in test env ONLY, never committed:
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_ANON_KEY_TEST=<anon-key> \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
npm run test:rls
```

What is asserted (see `tests/rls/unauthorized-access.test.ts`):

- Unauthenticated SELECT on `meeting_rooms` by id returns no rows.
- Unauthenticated direct INSERT into `meeting_rooms` / `participants` / `participant_locations` fails.
- With a service key: a fresh anonymous user who is NOT a member cannot SELECT `participant_locations`, cannot UPDATE another participant (verified unchanged via service-role read), and cannot SELECT the room by invite code.

If tests fail with “relation does not exist”, migrations have not been applied. If anonymous sign-in fails, enable the Anonymous provider (SUPABASE.md step 2).

## 4. Two-browser test (REQUIRED before marking Phase 2 complete)

**Status: PENDING.** Run this against a real Supabase project with migrations + functions deployed and frontend env vars set.

### Setup

- Browser A: your normal browser profile.
- Browser B: a **different browser** (e.g. Chrome vs Firefox) or a separate browser profile / private window with a fresh storage partition. Two tabs in the same profile are NOT sufficient — they share `localStorage`/cookies and would mask cross-session bugs.
- Both browsers open the same deployed (or `localhost`, if both browsers run on the same machine) app URL.

### Steps

1. **Browser A (host):** Create → title “Two-browser test”, display name “Host A”, pick any area → Create. Note the invite code + link from the Lobby.
2. **Browser B (guest):** Open the invite link (paste the full `/join/<CODE>` URL). Enter display name “Guest B”, pick a different area → Join.
3. **Lobby Realtime:** In Browser A, without reloading, Guest B should appear in the participant list within a few seconds, and the lobby status should show “Live”. In Browser B, toggle Ready on/off; Browser A should see Guest B's readiness change live. In Browser A, toggle Ready; Browser B should see it.
4. **Routes:** In both browsers, go to Routes. Both should see the same 3 spots and estimates for both participants.
5. **Compare:** In Browser B, reorder + save a ranking. In Browser A, reload Compare — the vote count should reflect Guest B's vote.
6. **Finalize (host-only):** In Browser B, attempt Finalize → expect an error (“Only the host can finalize”). In Browser A, finalize → both browsers' Navigate pages (navigate there in B) show the same final spot.
7. **Navigate:** Both browsers see per-friend ETAs for the final spot.
8. **Unknown code:** In Browser B, open `/room/ZZZZZZ/lobby` → error state + link to Join. Open `/join/ZZZZZZ` with a name → generic “no room found” error (no existence details leaked).

### Pass criteria

- [ ] Guest joins via the shared link in an independent session (no shared storage).
- [ ] Lobby participant list + readiness update live in both directions without reload.
- [ ] Routes/Compare/Navigate show consistent data in both browsers.
- [ ] Non-host finalize is rejected (403 surfaced as a clear error).
- [ ] Unknown codes fail generically in both browsers.
- [ ] No service-role key appears in browser DevTools (Network / Sources / `localStorage`).

### Troubleshooting

| Symptom | Fix |
|---|---|
| Guest sees “Room not found” after joining | Check function logs; confirm migrations + `join-room` deployed; confirm Anonymous auth enabled. |
| No live updates | Enable Realtime for `meeting_rooms` + `participants` (SUPABASE.md step 6); check the lobby status badge and retry. |
| Guest B appears in A but readiness never changes | Check `participants_update_own` policy + trigger (migration 0002); check browser console for PostgREST errors. |
| Finalize works for the guest | `finalize-meeting` not deployed or an old version is serving — redeploy and check logs. |

### Recording the result

When this test has been run, update the status table at the top of this file with the date, browsers used, and pass/fail per criterion. Until then, Phase 2 remains **unverified live**, even though the code, migrations, functions, and unit tests are complete.

## 5. Phase 3 map manual testing (real browser required)

**Status: PENDING.** These checks need a real browser with WebGL and
network access. Run them in Demo mode first (no env vars), then repeat
5.7–5.8 in Supabase mode with `VITE_ROUTING_PROVIDER=osrm` for live
routing. Respect the OSRM demo-server policy while testing: a handful
of route loads, not repeated bulk refreshes. Record the date, browser,
and pass/fail per item at the bottom of this section when done.

### 5.1 Build + dev server

Steps:

```bash
npm install
npm run build
npm run dev
```

- Expected: build exits 0; dev server serves the app; no console errors on load.
- Pass: `npm run build` and `npm test` both exit 0; `npm run test:maps` exits 0.

### 5.2 Desktop map load + attribution

Steps:

1. Open `/join/K7M2QX`, join as "Tester", go to the Lobby.
2. Observe the Map section. Open DevTools → Network; confirm requests to `tiles.openfreemap.org`.
3. Confirm the attribution control (bottom-right, "i" / compact) shows OpenStreetMap/OpenMapTiles attribution, and that it stays visible.

- Expected: map renders with streets/labels; all 4 demo participant markers + 3 spot pins visible (auto-fit); attribution visible.
- Pass: map loads without errors; attribution present and never hidden by overlays.

### 5.3 Mobile viewport + touch

Steps:

1. In DevTools device mode (360×740) or a real phone, open the Lobby and Route Discovery maps.
2. Pinch-zoom, one-finger drag, two-finger rotate/tilt.
3. Confirm the page does not overflow horizontally and map controls stay tappable.

- Expected: gestures work; controls (tilt/3D/Fit all) tappable; no horizontal scroll.
- Pass: usable at 360px width; map height ~320px; no layout breakage in surrounding cards.

### 5.4 GPS allow / deny / unavailable + manual pin + coordinate fallback

Steps:

1. Go to Create → "Pick on map" tab. Confirm the map shows a pin at the default location and no permission prompt has appeared yet (no request without a gesture).
2. Tap "Use my GPS location" and **Allow**. Confirm the pin moves, the label becomes "Current location (GPS)", and an accuracy note appears.
3. Reload, deny the permission (browser site settings → Block), tap the GPS button again. Confirm a clear denied message + guidance, with no crash.
4. Drag the pin and click elsewhere on the map. Confirm the coordinates readout updates each time.
5. Switch to "Enter coordinates" and "Choose an area" tabs. Confirm both still work and the form submits.

- Expected: GPS only requested on tap; allow/deny/timeout each produce clear messaging; pin drag/click updates the form value; keyboard alternatives (tabs) fully work.
- Pass: all five steps behave as described; submitting with a map-picked location creates the room with those coordinates (visible in the Lobby list).

### 5.5 Participant markers + popups + expired location

Steps:

1. In the Lobby map, tap each participant marker. Confirm the popup shows name, area label, updated time, and readiness.
2. Confirm the 4 markers have distinct colours matching the participant list avatars, with initials (not colour alone).
3. To test expiry: in Demo mode, open DevTools → Application → Local Storage, find the demo room, and set a participant location's `expiresAt` to a past time (or wait 2 hours). Reload the Lobby.

- Expected: popups show correct details; expired marker renders dimmed with an "expired" note in its popup; non-expired markers render normally.
- Pass: 4 distinct markers + correct popups; expired state visibly distinguished.

### 5.6 Auto-fit + fly-to + tilt + zoom + 3D toggle + raster fallback

Steps:

1. Route Discovery: confirm the map fits all participants + spots on load. Switch travel mode; confirm the camera does not jump unexpectedly (refit only on spot/mode change).
2. Tap a spot card / spot pin; confirm routes switch to that spot and the map refits.
3. Use the 0°/45°/60° tilt buttons, "Reset north", "Fit all", and the +/- zoom control. Confirm smooth transitions.
4. Finalize a spot, open Final Navigation: confirm the map shows routes to the final spot only, with tilt controls visible.
5. Zoom to 15+ in a built-up area with the vector style. Toggle "3D buildings" off/on; confirm buildings extrude when on (where data supports it).
6. Raster fallback: stop the dev server, set `VITE_MAP_STYLE_URL=https://127.0.0.1:9/broken.json` in `.env`, restart, open the Lobby map. Confirm a raster map appears with the fallback notice and the 3D toggle shows "unavailable". Remove the override afterwards.
7. Reduced motion: enable "Reduce motion" in OS/browser settings, reload Route Discovery. Confirm route lines render static (no marching-ants animation).

- Expected: camera behaves as described; 3D toggle works on the vector style and degrades gracefully on raster; fallback notice appears; reduced motion disables animation.
- Pass: all steps behave as described; no console errors from layer operations.

### 5.7 Animated routes + distance/time + OSRM vs demo labels + failure fallback

Steps (Demo mode, default `mock` provider):

1. Route Discovery: confirm animated dashed route lines from each participant to the selected spot, coloured per participant, with the RouteLegend showing distance/time + "Demo estimate — straight-line" for each.
2. Switch modes; confirm the legend updates and the selected card's footer rows match the legend values.
3. Confirm other (non-selected) cards keep their existing estimate rows.

Steps (OSRM mode — set `VITE_ROUTING_PROVIDER=osrm`, restart):

4. Reload Route Discovery. Confirm routes take ~1–5s to appear (throttled), follow roads (not straight lines), and are labelled "OSRM route (development)". Check Network: at most ~4 requests to `router.project-osrm.org`, spaced ≥1s apart, only for the selected spot + mode.
5. Switch mode and back; confirm the second load of the same mode is fast (cache) with no new OSRM requests.
6. Select Transit; confirm the label notes the driving-profile approximation.
7. Failure fallback: set `VITE_OSRM_BASE_URL=https://127.0.0.1:9` (unreachable), restart, reload Route Discovery. Confirm straight-line routes appear labelled "Estimated — OSRM unavailable" and the page stays usable. Restore the default afterwards.
8. Provider off: set `VITE_ROUTING_PROVIDER=off`, restart. Confirm maps show markers/pins with no route lines and no errors. Restore afterwards.

- Expected: labels always match the data source; no mock data presented as live; OSRM usage stays within policy (serial, cached, visible-screen only); failures degrade to labelled estimates.
- Pass: all steps behave as described; Network tab shows no Google/Mapbox/paid-provider requests and no OSRM request bursts.

### 5.8 Realtime two-browser location sync (Supabase mode)

Reuse the §4 setup (two independent browsers/profiles, Supabase configured, migrations + functions deployed).

Steps:

1. Browser A (host) creates a room; Browser B (guest) joins via the link. Both open the Lobby map.
2. In Browser B, tap "Update with my GPS location" (allow) or "Move my pin on the map" → drag → Save.
3. In Browser A, without reloading, confirm Guest B's marker moves to the new position within a few seconds and the participant list updates.
4. In Browser A, move the host pin the same way; confirm Browser B's map updates.
5. In both browsers, open Route Discovery and confirm the same spots/routes render (OSRM mode: both browsers fetch their own routes; values may differ slightly by cache timing but geometries should match the same endpoints).

- Expected: markers move live in both directions without reload; no camera jumps on Realtime updates (no refit fighting).
- Pass: live marker sync works both ways; lobby status shows "Live"; no errors in either console.

### 5.9 WebGL disabled + reduced motion

Steps:

1. Disable WebGL (e.g. Chrome: launch with `--disable-webgl` or block via `chrome://flags` "Disable WebGL"; Firefox: `webgl.disabled=true` in `about:config`).
2. Open the Lobby, Route Discovery, and Create → "Pick on map" tab.

- Expected: each map area shows the "Map unavailable — locations as text" fallback listing participants/spots/pin with coordinates; the rest of each page (forms, lists, buttons) works normally.
- Pass: no blank pages, no crashes; text fallback lists correct coordinates; re-enabling WebGL restores maps after reload.
- Reduced-motion expectations are covered in 5.6 step 7.

### 5.10 No paid-provider grep check

Steps:

```bash
grep -rni "google\|mapbox\|maps.googleapis" src/ index.html package.json || echo "CLEAN"
grep -rn "service_role\|SERVICE_ROLE" src/ || echo "NO SERVICE ROLE IN src/"
```

- Expected: `CLEAN` (zero matches for paid-provider references in source) and no service-role key in `src/`.
- Pass: both checks clean. (Docs may mention provider names factually in MAPS.md/README.md — that is not a code dependency.)

### Recording the Phase 3 result

When §5 has been run, update the status table at the top of this file with the date, browsers/devices used, provider settings tested (mock/OSRM/off), and pass/fail per item (5.1–5.10). Until then, Phase 3 live behaviour remains **unverified**, even though unit tests, the build, and the code review are complete.

## 6. Build check

```bash
npm run build
npx tsc --noEmit
```

Both must exit 0. `npm run build` already runs `tsc --noEmit` first.

## 7. Phase 4 engine + animation live testing (real browser required)

Status: **PENDING** — not run in this environment (no browser test
harness). Unit tests (`npm test`) and mocked integration tests
(`npm run test:integration`) cover the engine logic offline; this
section covers live behaviour against the public Overpass and OSRM
servers, GPS flows, and in-browser animation/3D rendering.

**Respect the public servers.** Run each live step once or twice,
with small searches (default settings). Do NOT run automated loops,
do NOT raise the candidate/request caps against the public servers,
and do NOT test failure injection by hammering endpoints. For
repeated testing, self-host Overpass/OSRM and point the env vars at
your instances (see ENGINE.md). If you see 429s, stop and wait.

### 7.1 Enable live search + verify the default endpoint

Steps:

1. In `.env`, set:
   ```
   VITE_PLACES_PROVIDER=overpass
   VITE_ROUTING_PROVIDER=osrm
   ```
   (Leave all other engine vars at defaults.)
2. Restart `npm run dev`. Open a room's Route Discovery page.
3. Confirm the Smart meeting points panel shows the "Live · Overpass + OSRM" badge.
4. Verify the Overpass endpoint independently (proves the default URL is alive):
   ```bash
   curl -s -X POST --data-urlencode "data=[out:json][timeout:10];node[\"amenity\"=\"cafe\"](around:500,12.9716,77.6412);out 1;" https://overpass-api.de/api/interpreter | head -c 200
   ```
   Expected: JSON with an `elements` array (possibly empty if no café is mapped within 500 m — the JSON shape is the check, not the count).
5. Verify OSRM independently:
   ```bash
   curl -s "https://router.project-osrm.org/route/v1/driving/77.6412,12.9716;77.6245,12.9352?overview=false&geometries=geojson&steps=false" | head -c 200
   ```
   Expected: JSON with `"code":"Ok"` and a `routes` array.

- Pass: badges correct; both endpoints return valid JSON. If either fails, record it and stop — live steps below cannot pass until the endpoint recovers (or use a self-hosted endpoint and note the override).

### 7.2 Optimization happy path (live)

Steps:

1. In Demo mode, join the sample room (`K7M2QX`) so you are a member with a location. Go to Route Discovery.
2. In the Smart meeting points panel: strategy Balanced, category Café, no max-travel limit, meeting time ~2h ahead. Tick the consent checkbox. Click "Find best meeting points".
3. Watch the Network tab: expect 1 Overpass POST (one search area for the Bengaluru group) followed by sequential OSRM `GET /route/v1/...` requests spaced ≥1s apart, at most 12 candidates × 4 participants = 48 requests (usually far fewer after discovery + dedup).
4. Wait for results. Read the top-5 list: rank, name, explanation (strategy, score, total/average/longest), per-participant times, and any warnings.

- Pass: results appear with real OSM place names/coordinates; explanations match the displayed times (spot-check the balanced score for one candidate: 0.4×avg + 0.4×max + 0.2×stddev); no "Demo" labels on live results; Network shows no request bursts (≥1s spacing) and no duplicate route URLs for identical pairs.
- Fail: straight-line-looking times (e.g. identical durations for very different road layouts), missing explanations, or bursts of parallel OSRM requests.

### 7.3 Strategies, constraints, and consent

Steps:

1. Re-run with strategy Minimum total, then Fairest (minimax). Note whether the top result changes and whether each explanation names the right strategy/score.
2. Re-run with max travel time 10 minutes. Expect several exclusions; expand "excluded places" and check each reason names the participant(s) over the limit.
3. Untick consent and click the button. Expect a consent error and zero network requests.
4. Change category to Park and re-run. Expect park results (or a clear "no places found" error if none are mapped nearby — either is a pass if the message names the category).

- Pass: all four behaviours as described; consent blocks the run before any request.

### 7.4 Failure injection (one at a time, then restore)

Steps:

1. **Bad Overpass URL:** set `VITE_OVERPASS_URL=https://invalid.example.invalid/api` (restart dev server), re-run. Expect "Live place search is unavailable — try again later. No estimates shown." and the existing spot list still visible below. Restore the URL.
2. **Offline:** disable network (DevTools offline), re-run. Expect the same clear unavailable error, no ranked results, no crash. Re-enable network.
3. **Provider off:** set `VITE_PLACES_PROVIDER=mock` (keep OSRM on), re-run. Expect the Demo badge + demo results labelled Demo (mixed configs never mix labels). Restore `overpass`.
4. **Bad OSRM URL:** set `VITE_OSRM_BASE_URL=https://invalid.example.invalid` (restart), re-run. Expect "Live routing is unavailable — try again later. No estimates shown." with NO ranked results (no silent estimates). Restore the URL.

- Pass: every failure shows a clear message, shows no live-looking ranked results, and never hides the existing content. Record any case where estimates appear after a live failure — that is a bug.

### 7.5 GPS / manual-pin flow into the engine

Steps:

1. On a phone or in a browser with location permissions, create/join a room using "Use my GPS location" (allow permission), then run a live search. Expect your GPS position among the origins (check per-participant times change vs the preset-area run).
2. Deny permission in a fresh browser profile: expect the GPS guidance + pin/coordinate fallbacks; set a pin, run a search, expect it to use the pinned location.
3. Let a location expire (or use a room whose locations are >2h old): run a search and expect a validation error naming the participant(s) with expired locations, with zero network requests.

- Pass: GPS/pin locations flow into the search; expired locations block the run with named participants.

### 7.6 Animation playback, toggles, 3D, and reduced motion

Steps (Final Navigation, finalized spot, any routing provider):

1. Press Play. Expect routes to reveal progressively from each origin in participant colours, with midpoint labels ("Name · time · distance") and a pulsing destination marker. Press Pause mid-way: the reveal freezes. Press Replay: it restarts from 0. Move the progress slider: the reveal jumps and playback pauses.
2. Toggle one participant's chip off: their route + label disappear; the map is not recreated (no flicker/reload). Toggle back on: they return.
3. Switch speed to 2× and replay: playback finishes in roughly half the time.
4. Toggle Immersive 3D on (vector style, city zoom): expect a pitched camera + buildings. If the toggle is disabled, note the reason shown; on the raster fallback (block the style URL per §5.6) expect the "3D unavailable — showing 2D map" note.
5. Grab the map mid-playback (drag): expect playback to pause.
6. Enable `prefers-reduced-motion` (OS setting or DevTools emulation) and reload: expect full routes shown statically, playback starting paused, a reduced-motion note, and a static (non-pulsing) destination marker. Pressing Play still animates on explicit request.
7. On a mid-range Android device (or throttled emulation: 4× CPU slowdown): play the animation and drag the map. Expect smooth-enough interaction with no freezes >1s and no page crash.

- Pass: all behaviours as described; animation never blocks routing UI; labels match the legend times; reduced-motion behaviour is respected.
- Note the device/browser used when recording.

### 7.7 Two-browser realtime check (reuse §4 setup)

Steps:

1. With Supabase configured and two independent browser sessions in the same room (see §4), open Final Navigation in both.
2. In browser A, update your location (GPS/pin in the lobby). In browser B, confirm the participant marker moves and the route lines/labels update without a page reload.
3. In browser B, start playback while A updates again: playback continues on the routes as loaded (a refetch updates lines on the next signature change — document what you observe).

- Pass: marker + route updates propagate live in browser B. (This extends §5.8 to animated routes.)

### 7.8 Request-count audit (live)

Steps:

1. Clear the Network tab. Run one live search (defaults, 4 participants).
2. Count: Overpass POSTs (expect ≤3, one per search area) and OSRM GETs (expect ≤60, unique pairs only, ≥1s apart).
3. Run the identical search again immediately. Expect Overpass served from cache (0 new POSTs within 10 min) and OSRM mostly cached (few/no new GETs).

- Pass: counts within budget; repeat runs are cached. Record the observed counts.

### Recording the Phase 4 result

When §7 has been run, update the status table at the top of this file with the date, browsers/devices used, provider settings tested, observed request counts (§7.8), and pass/fail per item (7.1–7.8). Until then, live engine/animation behaviour remains **unverified**, even though unit tests, mocked integration tests, the build, and the code review are complete. Do not claim live verification passed until §7 is run and recorded.

## 8. Coordination live testing (real Supabase project + two browsers required)

Covers the Phase 5 coordination layer: voting Realtime, host/non-host finalization, the finalized-destination announcement, ETA/navigation privacy, arrival, disconnect/reconnect, expiry, and the stale-optimization guard. **PENDING** until run against a real project with migration 0005 applied and the Edge Functions redeployed. §4/§5/§7 numbering is preserved; this section is additive.

### 8.1 Setup

1. Apply all migrations in order (including `20251117000005_0005_coordination.sql`) and redeploy all Edge Functions (see SUPABASE.md). Verify in Dashboard → Database → Replication that `meeting_rooms`, `participants`, `votes`, and `participant_locations` are all in the `supabase_realtime` publication.
2. Configure `.env` with `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` and start the app (`npm run dev` or `npm run preview` after `npm run build`). Confirm the header shows **Live · Supabase** (not Demo mode).
3. Use two independent browser sessions (two browsers, or one normal + one private window): browser A creates the room (host), browser B joins with the invite link. Keep both on the same room.

### 8.2 Voting Realtime

1. Open Compare in both browsers. In A, reorder the ranking and save. In B, confirm the group tally / "N of M voted" updates **without a reload**, within a couple of seconds.
2. In B, save a different ranking. In A, confirm the tally updates and B's vote is counted.
3. In A, save again with a different order. Confirm the tally reflects only the latest ranking (no double counting): check the first-choice counts add up to the number of voters.
4. Confirm neither browser shows the other participant's full ranking anywhere — only aggregates, "Your current #1", and participation counts.

- Pass: tallies converge in both browsers with no reload; one active ranking per participant; no ranking leakage.

### 8.3 Host / non-host finalize + announcement

1. In browser B (non-host), confirm the finalize button is disabled with "Only the host can finalize" text, and no per-spot host finalize buttons are shown.
2. In browser A (host), confirm the finalize button names the group winner. Click it: an inline confirm card appears ("Finalize \<spot\>? Everyone will see this destination."). Cancel once — nothing changes. Click again and Confirm.
3. Confirm A navigates to Final Navigation. In B (no reload), confirm the announcement banner appears on the current page: "Meeting point locked in: \<spot name\> — \<address\>. Finalized by host at \<time\>."
4. In B, visit Lobby, Routes, Compare, and Navigate: the banner shows the **same** spot name on all four pages.
5. In B, confirm voting controls are disabled with the finalized message. In A, confirm a second finalize is not possible (button replaced by the "View final destination" link).

- Pass: only the host can finalize; the group winner is the default; every page in both browsers shows the same destination; no re-finalize.

### 8.4 Concurrent finalize / stale version

1. With a fresh room, open Compare in both browsers as host (A) and non-host (B) — then, in a third session, sign in as the host in a second browser (same host identity is not possible across anonymous sessions, so simulate with two host-capable flows instead): open Compare in A, and in A open a second tab on Compare.
2. Finalize in tab 1. In tab 2 (stale view), attempt to finalize: confirm the UI refetches and shows the current destination rather than a bare error, and the destination is unchanged.
3. (Optional, via SQL) Confirm `decision_version` incremented by exactly 1 and `finalized_at` is set.

- Pass: stale finalize does not overwrite the decision; the UI recovers by refetching.

### 8.5 ETA + navigation privacy check (DOM/Network inspection)

1. On Final Navigation in both browsers, confirm each travel-list row shows distance, duration, and an "ETA … if leaving now" label.
2. In browser A, inspect the DOM: **only your own row** contains navigation links. Confirm the own-row OSM link contains your own coordinates and the spot coordinates, and the `geo:` link contains only the spot coordinates.
3. Confirm other participants' rows contain **no** `<a>` with coordinates and no coordinate text. Confirm the shared "Directions & sharing" links contain only spot coordinates (no `from=` origin).
4. In DevTools Network, confirm no request URL contains another participant's coordinates (map tile URLs contain tile coordinates, which are expected — look for the exact participant lat/lng values).
5. Confirm no link or text anywhere points to `google.com/maps`.

- Pass: own-row-only links, spot-only shared links, no coordinate leakage, zero Google URLs.

### 8.6 Arrival

1. After finalization, in browser B tap "I've arrived". In A (no reload), confirm the arrival count and B's "Arrived ✓" label update in the Lobby list and on Final Navigation.
2. In B, tap again to clear: confirm the label returns to "On the way" in both browsers.
3. Confirm there is no arrival control on other participants' rows, and no arrival control before finalization (fresh room).

- Pass: optional, reversible, own-row only, Realtime propagation.

### 8.7 Disconnect / reconnect

1. With both browsers in the room, in browser B open DevTools → Network → **Offline** (or toggle the OS network off). Confirm the status changes to Offline and a banner/retry appears; the last room state stays visible (no blank screen).
2. While offline in B, vote in A. Back online in B: confirm the status recovers (Reconnecting… → Live) and B's view updates without a manual reload (a manual Retry/Reload must also work).
3. Hide the tab (switch apps/minimize) for ~30 seconds, then return: confirm the room refetches (e.g. a vote cast in A while hidden appears).
4. (Optional) In Supabase Dashboard → Realtime, or by restarting the dev server proxy, force a channel drop; confirm bounded retries (status shows Reconnecting…, then Live or an error with Retry — never an endless spinner).

- Pass: offline is surfaced, recovery is automatic with a manual fallback, no polling loops, no infinite retry.

### 8.8 Expiry

1. Create a test room, then in the SQL editor set its `expires_at` to 1 minute in the past (do not use a >7-day-old value — the cleanup function would prune it).
2. Reload the room pages: confirm the expired banner shows, voting/finalize/search actions are disabled, and a "Create a new meeting" link is present.
3. Open the join link in a fresh session: confirm a clear "This meeting link has expired." message (HTTP 410 from `join-room`).
4. Confirm a finalized room with a past `expires_at` still shows its destination banner (finalized rooms are never auto-expired for display).
5. (Optional) Invoke `cleanup-expired-locations` with the cron secret and confirm the response counts (`deletedLocations`, `expiredRooms`, `prunedRooms`) and that the expired room's status flips to `expired` while non-expired rooms are untouched.

- Pass: expired rooms block actions with clear messaging; finalized destinations persist; cleanup counts look right.

### 8.9 Stale optimization

1. In Route Discovery, run a Smart meeting-point search (demo search is fine). Note the results.
2. In the other browser, update a location (GPS/pin in the lobby) or join as a new participant. Confirm the first browser's results show the "Stale — the room changed since this search. Re-run…" banner.
3. Finalize the room, then return to Route Discovery: confirm the search button is disabled with the finalized message.
4. Confirm finalization used the group winner / host-selected spot — not a spot id from the stale search.

- Pass: stale banner appears on room change; searches are blocked once finalized/expired; finalize never consumes a stale result.

### Pass criteria (all of §8)

- 8.2–8.9 each pass as described; the same destination is visible in both browsers on all four room pages; no Google URLs; no other participant's coordinates in links/URLs; no blank/spinner-only states during disconnects.
- Record: date, browsers/devices, Supabase project ref (not keys), migration/function deploy confirmation, and pass/fail per item (8.2–8.9).

### Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Votes do not update live | `votes` missing from the Realtime publication — re-run migration 0005, check SUPABASE.md §6. |
| Finalize always 409s | Stale page — reload. If it persists, check `decision_version` in SQL and the `finalize-meeting` logs. |
| Banner missing in one browser | That browser is on an old bundle — hard-refresh. The banner reads `room.finalized_spot_id` from the refetched detail. |
| Reconnect never recovers | Check Realtime is enabled for all four tables; check browser console for channel errors; use the Retry/Reload button. |
| Expired room still joinable | `join-room` not redeployed (410 guard), or `expires_at` is in the future — check the row in SQL. |
| Cleanup returns 401 | Missing/wrong `x-cron-secret` header or `CLEANUP_SECRET` not set — see SUPABASE.md §5. |

### Recording the coordination result

When §8 has been run, update the status table at the top of this file with the date, browsers/devices used, and pass/fail per item (8.2–8.9). Until then, live coordination behaviour remains **unverified**, even though unit tests, mocked integration tests, the build, and the code review are complete. Do not claim live verification passed until §8 is run and recorded.
