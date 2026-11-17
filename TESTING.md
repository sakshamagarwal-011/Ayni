# Testing — MeetSync 3D

## Verification status

| Check | Status |
|---|---|
| Unit tests (`npm test`) | Run locally during development — see command output in the handoff / CI. Must pass with no env vars. |
| Production build (`npm run build`) | Run locally during development — see command output in the handoff / CI. |
| RLS unauthorized-access tests (`npm run test:rls`) | **PENDING** — requires a real Supabase project + test env vars. Not run in this environment (no credentials were invented or used). |
| **Two-browser test (see below)** | **VERIFIED 2026-11-17** — run against the Vercel deployment https://meetsync-roan.vercel.app (Supabase project rgihmbpijneqzqltiqpp), room “Two-browser test”, code 3VJ6K7. Browser A = cloud browser default profile (Host A, Indiranagar); Browser B = separate “Guest B” profile (Guest B, Koramangala). All §4 steps passed; see §4 result record. One deviation: guest finalize was blocked by a disabled button (UI guard), the Edge Function 403 path was not exercised in this run. DevTools criterion verified by inspecting the deployed JS bundles (0 `service_role` occurrences) rather than in DevTools UI. |
| **Phase 3 map manual tests (§5)** | **PARTLY VERIFIED 2026-11-17** — v0.6.3 live on https://meetsync-roan.vercel.app, rooms QCGZCJ/KNRGQG/KQQCXR. Verified: map load + OSM attribution, create-flow location-required validation, GPS-deny fallback, 9 city presets, scooter mode (no bicycle), both participants' markers + spot markers, manual pin move + cancel (unsaved), both participants' OSRM route lines (corrected after a viewport artefact), realtime location sync (join arrived without reload), OSRM vs demo labels. NOT confirmed: visible tilt perspective change on the Lobby map (buttons change pressed state; screenshots stayed flat — the Navigate map DID look tilted at 45°; needs a real-device check). Unverified: mobile 360×740 touch, WebGL-disabled fallback, reduced motion, raster fallback. See the 2026-11-17 record at the end of this file. |
| **Engine + animation live tests (§7)** | **LIVE SEARCH + RANKING VERIFIED 2026-11-17** — v0.6.3, Photon places + OSRM (VITE_PLACES_PROVIDER=photon). Room KQQCXR: 1-person + 2-person searches, Balanced + Fairest strategies, consent gate, explanations naming longest-trip participant, warnings (single-participant, static times, pre-filter), stale-result handling, failure messaging (earlier Overpass timeout errors). Direct Overpass + the Supabase proxy are blocked from cloud networks (406 / 502) — Photon is the working live path; see ENGINE.md. **PARTIAL:** animation controls + progress + end-state verified, but progressive line-drawing was not visually confirmed (map tiles dark in captured frames); immersive-3D toggle stayed disabled ("Checking whether 3D buildings are available…") — 3D rendering unverified; request-count audit (§7.8) not run. See the record at the end of this file. |
| **Coordination live tests (§8)** | **MOSTLY VERIFIED 2026-11-17** — v0.6.3, room KQQCXR, Host P (default profile) + Guest B (separate profile). Verified: 8.2 voting incl. replace-on-save (tally stayed 1 of 2, winner moved), 8.3 host finalize + same announcement on Lobby/Routes/Compare/Navigate in both browsers, 8.5 own-row-only navigation links (both directions) + spot-only shared links, 8.6 arrival confirm + reversible (own browser; cross-browser count seen), 8.9 stale-optimization banner on live join. Partial: 8.7 — a transient "Live updates unavailable" notice appeared once and cleared on its own (recovery observed, no forced-offline test). Unverified: 8.4 concurrent finalize, 8.8 expiry (needs SQL-set past expiry), 8.5 network-level coordinate-leakage check. See the record at the end of this file. |
| **Audit-fix pass (2026-11-17)** | **APPLIED + LIVE-VERIFIED 2026-11-17** — 18 majors + 58 minors implemented (minor #21 antimeridian intentionally skipped: no India impact); migrations `0006_audit_hardening` + `0007_scooter_mode` applied by the user via Dashboard SQL Editor and verified via API (atomic replace_votes locked to authenticated users, security lockdown in effect); Edge Functions redeployed (v3, + places-search). India-first additions verified live: scooter mode, 9 city presets, 5 new categories. Unit (359) + integration (31) tests pass; build passes. Open follow-up: minor #31 device-clock skew (no server-time source client-side). |
| **Publish live results (§7.9/§8.10)** | **VERIFIED 2026-11-17** — v0.7.0 (migration 0008 + `publish-results`) + v0.7.1 (migration 0009, shared `published_rank`). Rooms WC7E75 (publish → vote → finalize a live spot) + 69S8W8 (shared ranked order for a guest with no engine order; supersede). Verified: publish button + success/published states, live propagation without reload, all 5 published spots in ranked order on the guest's Compare page, no invented rating/price/open-now on live spots, vote + finalize of a live spot, supersede (new batch leads live, old batch drops out). NOT run: §7.9 step 7 re-publish dedup, §7.9 step 9 finalized-room negative, §8.10 step 5 SQL check, reload-persistence of the shared order (fresh-join evidence covers the server-authoritative claim). See the record at the end of this file. |
| **Map follows search + empty rooms + map fit (§7.9 steps 10–12)** | **VERIFIED 2026-11-18** — v0.7.2 (preview: map follows the search) + v0.7.3 (new rooms start empty; fit frames participants + selected spot; `create-room` v4, no migration). Rooms YVNJ6B (v0.7.2 run + v0.7.3 fit recheck) + KVCD2N (fresh empty room, full flow). Verified: search auto-previews #1 (header, routes, legend), tap-to-preview with ring, room-card tap clears the preview, no preview leak onto Compare, empty states with search+publish guidance on Routes/Compare, 5 km Delhi framing after search and selection changes, "Fit all" still frames everything, vote + finalize from published-only spots with identical announcements and own-row-only links. The v0.7.2 run found the India-wide fit defect (fixed in v0.7.3) and an unexplained 10 m blank-zoom observation that did NOT reproduce on v0.7.3 (cause unknown). See the record at the end of this file. |

## 1. Unit tests (no Supabase needed)

```bash
npm install
npm test
```

Covers: invite-code format/normalization, title/display-name/lat/lng validation, haversine distance, deterministic route estimates, mock-data shape (4 friends, 3 spots).

### 1.1 Error boundary (v0.7.4)

The `ErrorBoundary` around the page outlet (`src/components/ErrorBoundary.tsx`, wired in `Layout.tsx`) is unit-tested in `tests/unit/errorBoundary.test.ts` (jsdom render; see the file header for why server rendering cannot exercise a boundary): a throwing child renders the fallback — "Something went wrong" + Reload the page / Back to home — instead of a blank render, a healthy child renders normally, the error state clears when the route key changes (and stays on the fallback when it doesn't), and `getDerivedStateFromError` returns the error state. Coverage: render-time crashes in the page tree, including lazy chunk-load failures (the Reload button fixes those). It does NOT catch event-handler or async errors — those keep their existing handling (service fallbacks, reconnect, retry UI). No `window.onerror` / `unhandledrejection` handlers are added, and the caught error is logged to `console.error` only (nothing leaves the device).

Live regression VERIFIED 2026-11-18 (~00:58 IST, bundle `assets/index-ByoBjas8.js`): all 7 pages (Landing, Create, Join, room KVCD2N Lobby/Routes/Compare/Navigate) rendered their normal content with no fallback shown and no visible errors. A real crash-trigger test needs a fault-injection build and was NOT run live — do not claim the fallback itself was verified in a browser until that is done.

## 2. Demo-mode manual checklist (no env vars)

```bash
npm run dev
```

- [ ] Landing loads; header shows “Demo mode — Supabase not configured”.
- [ ] Create: empty title / short name / missing location show inline errors; valid form creates a room and lands in the Lobby with a 6-char code.
- [ ] Lobby: invite code + copy-link work; participants listed; ready toggle flips; “Discover routes” navigates onward.
- [ ] Routes: mode tabs (Walk/Scooter/Car/Transit) change estimates; fairest spot is ranked #1; back/forward navigation works.
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

**Status: VERIFIED 2026-11-17** (see result record below). Run against the Vercel deployment with the real Supabase project, migrations + functions deployed, and frontend env vars set.

### Setup

- Browser A: your normal browser profile.
- Browser B: a **different browser** (e.g. Chrome vs Firefox) or a separate browser profile / private window with a fresh storage partition. Two tabs in the same profile are NOT sufficient — they share `localStorage`/cookies and would mask cross-session bugs.
- Both browsers open the same deployed (or `localhost`, if both browsers run on the same machine) app URL.

### Steps

> Since v0.7.3, new live rooms start with ZERO spots (no seeded demo spots). Steps 4–6 below therefore need a search + publish first: in Browser A, run a live search on Routes and click "Add these places to the vote" before checking Routes/Compare/finalize. (The 2026-11-17 verification record below ran against rooms with seeded spots and stays as history.)

1. **Browser A (host):** Create → title “Two-browser test”, display name “Host A”, pick any area → Create. Note the invite code + link from the Lobby.
2. **Browser B (guest):** Open the invite link (paste the full `/join/<CODE>` URL). Enter display name “Guest B”, pick a different area → Join.
3. **Lobby Realtime:** In Browser A, without reloading, Guest B should appear in the participant list within a few seconds, and the lobby status should show “Live”. In Browser B, toggle Ready on/off; Browser A should see Guest B's readiness change live. In Browser A, toggle Ready; Browser B should see it.
4. **Routes:** In Browser A, run a live search and publish the results. In both browsers, go to Routes. Both should see the same published spots and estimates for both participants. Before publishing, Routes shows the "No meeting spots yet" empty state with the working search panel (not an error).
5. **Compare:** In Browser B, reorder + save a ranking. In Browser A, reload Compare — the vote count should reflect Guest B's vote.
6. **Finalize (host-only):** In Browser B, attempt Finalize → expect an error (“Only the host can finalize”). In Browser A, finalize → both browsers' Navigate pages (navigate there in B) show the same final spot.
7. **Navigate:** Both browsers see per-friend ETAs for the final spot.
8. **Unknown code:** In Browser B, open `/room/ZZZZZZ/lobby` → error state + link to Join. Open `/join/ZZZZZZ` with a name → generic “no room found” error (no existence details leaked).

### Pass criteria

- [x] Guest joins via the shared link in an independent session (no shared storage). Verified 2026-11-17: Guest B joined via `/join/3VJ6K7` in a separate browser profile.
- [x] Lobby participant list + readiness update live in both directions without reload. Verified 2026-11-17: B's join + Ready appeared in A without reload (2 participants · 1 ready); A's Ready then appeared in B without reload (2 ready).
- [x] Routes/Compare/Navigate show consistent data in both browsers. Verified 2026-11-17: identical 3 spots + estimates in both; B's saved ranking visible to A after reload (1 of 2 voted, Central Brew House group winner); both Navigate pages showed Central Brew House + the same ETAs.
- [x] Non-host finalize is rejected (403 surfaced as a clear error). Partially verified 2026-11-17: the “Finalize (host only)” button was disabled for Guest B (UI guard), so no finalize attempt reached the server from B. The Edge Function 403 path was NOT exercised in this run; host finalize via the Edge Function succeeded (confirm dialog → “Finalizing…” → Navigate page + announcement).
- [x] Unknown codes fail generically in both browsers. Verified 2026-11-17 (Browser B): `/room/ZZZZZZ/lobby` → “Room not found” card with “Try again” / “Go to Join Meeting”; `/join/ZZZZZZ` submit → “Could not join — No meeting room found for invite code "ZZZZZZ". Check the code and try again.”, form retained.
- [x] No service-role key appears in browser DevTools (Network / Sources / `localStorage`). Verified 2026-11-17 by inspection instead of DevTools UI: the deployed JS bundles (main + lazy map chunk) contain 0 occurrences of `service_role`; only the publishable anon key / project ref is baked in.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Guest sees “Room not found” after joining | Check function logs; confirm migrations + `join-room` deployed; confirm Anonymous auth enabled. |
| No live updates | Enable Realtime for `meeting_rooms` + `participants` (SUPABASE.md step 6); check the lobby status badge and retry. |
| Guest B appears in A but readiness never changes | Check `participants_update_own` policy + trigger (migration 0002); check browser console for PostgREST errors. |
| Finalize works for the guest | `finalize-meeting` not deployed or an old version is serving — redeploy and check logs. |

### Recording the result

Run result (2026-11-17, 20:02–20:06 IST): PASSED with the two notes above (guest-finalize 403 path not exercised; DevTools criterion verified by bundle inspection). Room “Two-browser test”, code 3VJ6K7, deployment https://meetsync-roan.vercel.app. Both browsers showed the “Live · Supabase” badge throughout; no app errors were observed at any step. Estimates shown were labelled “Demo estimate — straight-line” (expected: the deployment does not set the OSRM/Overpass opt-in vars).

Bug found during this run: the “Find best meeting points” button on Routes was disabled for joined members with “Join this room first to run a search.” Root cause: `OptimizationPanel` called `isActionAllowed(..., 'optimize', ...)` without `isMember`, which defaults to `false`. Fixed in the same commit as this record by passing `isMember: detail.currentParticipantId != null`. Re-verification (2026-11-17, fresh room CN9DBA “Search check” on the redeployed build): the button is ENABLED for the joined host, no “Join this room first” message appears, and a consented demo search completed with no errors, returning “Demo results · 3 places found, 3 routed, 3 ranked” with balanced-score rankings. Fix confirmed.

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

### 7.9 Publish live results as votable spots (v0.7.0; requires migrations 0008 + 0009 and deployed `publish-results`)

Prerequisite: a live search (Photon/Overpass/proxy + OSRM) in a real room with two browsers (reuse the §4/§8 setup: A = host, B = guest, separate profiles).

1. In A, run a live search and confirm the "Add these places to the vote" button appears under the results with the "Everyone in the room will see them on Compare & vote." note. In Demo mode (or after a demo search), confirm the button does NOT appear.
2. In A, click the button. Confirm the success note ("Added to the vote — N places now on Compare & vote.") and the "Published ✓ — view on Compare & vote" link, and that the button cannot be clicked again for the same result set.
3. In B (no reload), open Compare & vote: confirm the published places appear as votable spots with the "Live place" badge, NO rating row, NO "Open now"/"Closed now" badge, and NO "Demo spot" badge. (A fresh room has no seeded spots since v0.7.3; the "Demo spot" labelling check applies to Demo mode and rooms created before v0.7.3.)
4. **Shared published order (v0.7.1):** with 5 published spots in a fresh room (no seeded spots since v0.7.3) and NO search ever run in B (no engine order in that browser), confirm B's Compare page shows ALL 5 published spots, in the published ranked order, without a reload. Reload B and confirm the same order persists (server-authoritative, not session state).
5. In B, rank a published live spot #1 and save. In A, confirm the tally updates live.
6. In A, finalize the live spot (host). In both browsers, confirm the finalized announcement names the live spot, and the Final Navigation page shows it with no invented rating/price/open-now.
7. In A, re-run the same search and publish again: confirm no duplicate spots appear (same rows, same ids — check the spot count on Compare stays the same) and existing votes still reference the same spots.
8. **Supersede (v0.7.1):** in A, run a search with a different category/area and publish the new batch. In B, confirm the NEW batch leads the compared set in ranked order and the OLD batch no longer leads (it falls back to tally order behind the new batch).
9. (Negative) In a finalized room, confirm the publish button is disabled/absent with the finalized explanation, and a direct `publish-results` call with a finalized room returns 409.
10. **Map follows the search (v0.7.2):** after a live search, confirm the map header reads "routes to \<ranked #1\>" with routes drawn to it (not to the first room spot). Tap result #3: confirm the map header, route lines, and legend re-point to #3 and that card shows the selected ring. Tap a room spot card: confirm the map returns to that room spot and no result card stays ringed. On Compare & vote, confirm the previewed-but-unpublished place does NOT appear (previews are local UI state only).
11. **New room starts empty (v0.7.3):** create a fresh live room (do NOT search yet). On Routes, confirm the "No meeting spots yet" empty state with guidance to search + publish, the working search panel, and a map showing participant markers only. On Compare & vote, confirm the "No spots to compare" empty state, no usable finalize control, and no crash. On Lobby, confirm the room renders normally with no spots. Then search + publish and confirm the spots appear in all three places.
12. **Map fit frames the selection (v0.7.3):** in a room whose participants are far from some room spots (e.g. Delhi participants + Bengaluru demo spots in a pre-v0.7.3 room, or after publishing Delhi results), run a search and confirm the map reframes on the Delhi area (participants + selected spot) — NOT the whole of India. Tap another result and confirm the viewport reframes on the new selection. Click "Fit all" and confirm the map widens to frame EVERYTHING (all participants + all spots). Recheck the unexplained 10 m blank-zoom observation from the v0.7.2 run (cause unknown — record what the viewport does on each selection change).

- Pass: publish → live visibility in the second browser → shared ranked order for a guest with no engine order → vote → finalize → navigate, with honest labelling throughout, no duplicates on re-publish, supersede on a new batch, the Routes map following the search (auto-preview + tap-to-preview) without leaking previews onto Compare, fresh rooms starting empty with guiding copy, and selection-driven map framing with "Fit all" still framing everything. Record the room code, browsers, and pass/fail per step.

### Recording the Phase 4 result

When §7 has been run, update the status table at the top of this file with the date, browsers/devices used, provider settings tested, observed request counts (§7.8), and pass/fail per item (7.1–7.8). Until then, live engine/animation behaviour remains **unverified**, even though unit tests, mocked integration tests, the build, and the code review are complete. Do not claim live verification passed until §7 is run and recorded.

## 8. Coordination live testing (real Supabase project + two browsers required)

Covers the Phase 5 coordination layer: voting Realtime, host/non-host finalization, the finalized-destination announcement, ETA/navigation privacy, arrival, disconnect/reconnect, expiry, and the stale-optimization guard. **PENDING** until run against a real project with migration 0005 applied and the Edge Functions redeployed. §4/§5/§7 numbering is preserved; this section is additive.

### 8.1 Setup

1. Apply all migrations in order (including `20251117000005_0005_coordination.sql`) and redeploy all Edge Functions (see SUPABASE.md). Verify in Dashboard → Database → Replication that `meeting_rooms`, `participants`, `votes`, and `participant_locations` are all in the `supabase_realtime` publication.
2. Configure `.env` with `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` and start the app (`npm run dev` or `npm run preview` after `npm run build`). Confirm the header shows **Live · Supabase** (not Demo mode).
3. Use two independent browser sessions (two browsers, or one normal + one private window): browser A creates the room (host), browser B joins with the invite link. Keep both on the same room.
4. Since v0.7.3, new live rooms start with ZERO spots. The voting/finalize checks below (§8.2/§8.3) need spots first: in A, run a live search on Route Discovery and publish the results, then proceed. (Demo mode and rooms created before v0.7.3 still contain their sample/seeded spots.)

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

### 8.10 Publish propagation + engine order (v0.7.0; shared published order v0.7.1; requires migrations 0008 + 0009 and deployed `publish-results`)

Companion to §7.9 (which covers the publish → vote → finalize flow end to end). This section covers the coordination mechanics:

1. In A, publish a live search. In B (no reload), confirm the new spots appear on Compare & vote within a couple of seconds — propagation rides the `decision_version` bump on the room row, not a spots subscription.
2. In A, open Compare & vote immediately after publishing: confirm the published spots lead in engine order (the panel saved the returned ids + returned version). In B — which has no stored engine order — confirm the same spots lead in the SAME published ranked order (shared `published_rank`, v0.7.1), not tally order: with 5 published spots in a fresh room (no seeded spots since v0.7.3), B must see all 5 published spots in the capped top 5.
3. In A, confirm the just-published search now shows the stale banner (the version moved) while the published state ("Published ✓ — view on Compare & vote") stays visible. A new search re-enables publishing.
4. In A, publish a second, different batch. In B (no reload), confirm the new batch leads and the old batch no longer does (supersede).
5. (Optional, via SQL) Confirm `decision_version` incremented by exactly 1 per publish, the new rows have `source = 'live'`, non-null `osm_id`, and `published_rank` 1..N in submitted order, the previous batch's rows now have `published_rank IS NULL`, and re-publishing the same places did not create duplicate rows.

- Pass: live propagation without reload; engine order for the publisher, shared published-rank order for everyone else; stale banner after own publish; version +1 per publish; supersede on re-publish; no duplicate rows.

### Pass criteria (all of §8)

- 8.2–8.10 each pass as described; the same destination is visible in both browsers on all four room pages; no Google URLs; no other participant's coordinates in links/URLs; no blank/spinner-only states during disconnects.
- Record: date, browsers/devices, Supabase project ref (not keys), migration/function deploy confirmation, and pass/fail per item (8.2–8.10).

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

## Live verification record — 2026-11-17 evening (v0.6.3, Photon + OSRM)

Deployment: https://meetsync-roan.vercel.app (bundle `assets/index-EO6C9n4N.js`, verified to contain the Photon markers), Supabase project `rgihmbpijneqzqltiqpp`, `VITE_PLACES_PROVIDER=photon` + `VITE_ROUTING_PROVIDER=osrm` (Production + Preview). Browsers: cloud browser default profile (Host P) + separate "Guest B" profile `pcecc08bfba1c`. Room "Live test photon", code **KQQCXR**. All times IST, 2026-11-17.

### Places saga — why Photon (context for §§5/7)

Direct Overpass (`overpass-api.de`) returns HTTP 406 to datacenter/cloud networks (VM + cloud browser); the kumi/private.coffee mirrors answer tiny queries but time out on the app's search (26 s server-side timeout, zero elements); the Supabase `places-search` proxy (deployed 2026-11-17, JWT + validation verified) also returns 502 — Overpass is unreachable from Supabase's network too. Photon category search (`include=osm.<key>.<value>` + bbox, no `q`) was verified live first via direct browser GETs (real cafés regardless of name; Indiranagar station found), then end-to-end below. Comma-combined `include` values do NOT mix (one category dominates), so the client issues one sequential request per category.

### §7 — live search + ranking (VERIFIED)

- 1-person search (Host P, Indiranagar, Balanced, Café, consented, ~22:58): under 1 minute, no error. Summary: "Live results · 30 places found, 12 routed, 5 ranked · places via photon.komoot.io." Badge: "Live · Photon + OSRM". Top 3: Gloria Jean's, Kopitiam Lah, Neon Market (all 1 min, score 0.8). Warnings shown: single-participant, static road times, pre-filter note.
- 2-person search (Guest B joined from Koramangala; re-run ~23:02): under 1 minute. Same summary counts. Top 3: Chai Days (Host P 1.1 km · 2 min; Guest B 4.8 km · 5 min), Lavonne Café, Shinto. Explanation: "Chai Days ranks by Balanced score (score 3.7): total 7 min, average 4 min, longest 5 min across 2 required participants. Longest trip: Guest B (car, 5 min)." Single-participant warning gone.
- Fairest (minimax) re-run (~23:05): IDENTICAL top 3/order — correct, not a bug: all five ranked candidates share the same 5-minute longest trip, so both strategies order by the same tie-breaks (score 5.0, "ranks by Fairest (shortest longest trip)"). Scores sort ASCENDING (lower = better cost): ranks #4/#5 showing 3.8 below #1–#3 at 3.7 is correct ordering.
- Midpoint clustering is data coverage, not a ranking bug: a limit-50 Photon probe of the same bbox returned 50 cafés, but only 3 in the central band (lat 12.94–12.96); 21 sit in the tight Koramangala cluster (lat < 12.94) and 26 north. The engine correctly ranks what is mapped. No limit change made (raising the cap would add Koramangala cafés, not central ones).
- Known product gap (open decision, NOT a defect in the search): live Photon results are informational only — voting/finalizing operate on the room's seeded `candidate_spots` rows. The engine→Compare ordering (`saveEngineSpotOrder`) applies only to demo-mode candidates (`mock/<spot-id>`); live OSM places have no spot rows, so the live #1 (Chai Days) cannot be voted on or finalized. Persisting engine results as votable spots needs a design decision (new server path + UI affordance).

### §5 — maps (PARTLY VERIFIED)

- Verified: lobby map with both participant markers (HP/GB) + 3 spot markers; manual pin ("Move my pin on the map": tap moved pin 12.9352,77.6245 → 12.9498,77.6231, Cancel left the saved location unchanged); both participants' dashed OSRM route lines to Central Brew House (purple Host P + teal Guest B, converging on the pin — an earlier "only one line" report was corrected: viewport artefact); realtime join without reload (GB marker + estimates + stale banner appeared live); "Live · Supabase" header; GPS-deny fallback, 9 presets, scooter mode, create-flow validation (earlier rooms, same build family).
- NOT confirmed: visible tilt perspective on the Lobby map — tilt buttons (0°/45°/60°) change pressed state and 3D footprints show when zoomed in, but screenshots stayed flat/top-down; the Navigate-page map DID look tilted at 45°. The pitch code path reads correctly (`setPitchDegrees` → `easeTo({pitch})`); needs a real-device visual check before calling it a bug. M-13 (immersive-off camera restore) not directly exercised.
- Unverified: mobile 360×740 touch, true GPS allow, WebGL-disabled fallback, reduced motion, raster fallback, §7.8 request-count audit.

### §7 animation + §8 coordination (MOSTLY VERIFIED)

- §8.2 voting: Guest B saved Central Brew House #1, then replaced with Blue Bean #1 — tally stayed "1 of 2 participants voted", winner moved, "Saving again replaces it — you always have one active vote." (atomic `replace_votes` path). Host saw the tally live without reload.
- §8.3 finalize: host-only button disabled for Guest B; host confirmed "Finalize The Blue Bean Café?" → auto-navigated to Final Navigation. Announcement identical on Lobby/Routes/Compare/Navigate in BOTH browsers: "Meeting point locked in: The Blue Bean Café — 100 Ft Road, Indiranagar, Bengaluru / Finalized by host at 17/11/2026, 23:09:46."
- §8.5 privacy: directions links (OSM + `geo:`) on each viewer's OWN row only, both directions; shared links are spot-only with the no-starting-point note; zero Google URLs observed.
- §8.6 arrival: Host P confirmed arrival → "1 of 2 arrived", row "Arrived ✓", button became reversible "Not arrived yet — clear my arrival"; Guest B's view showed the count + Host P "Arrived ✓". Cross-browser clear/reverse NOT tested.
- §8.9 stale guard: the "Stale — the room changed since this search. Re-run…" banner appeared live on the Routes page when Guest B joined.
- §8.7 reconnect (PARTIAL): a "Live updates unavailable" notice appeared once on the Host's Routes page during the 1-person run and cleared on its own (header back to "Live · Supabase", no reload). No forced-offline/DevTools test was possible in the cloud browser.
- Animation (PARTIAL): Route playback controls present (Play/Pause, Replay, 1×/2×, progress slider, per-participant toggles, label chips "Host P · 2 min · 990 m" / "Guest B · 6 min · 5.0 km"); progress advanced 0% → 100% in ~10 s at 1×. Progressive line-drawing was NOT visually confirmed (map tiles dark/unloaded in captured frames). "Immersive 3D · off" stayed disabled with "Checking whether 3D buildings are available… Showing the 2D map." — 3D rendering in Final Navigation UNVERIFIED.
- §8.4 concurrent finalize + §8.8 expiry: UNVERIFIED (expiry needs a room with `expires_at` set to the past via SQL Editor).
- Observation (no conclusion): Guest B's own Navigate row showed 15 min · 5.6 km while Host P's view showed Guest B at 6 min · 5.0 km — per-viewer travel-mode state and/or OSRM route variance; not investigated as a defect.

## Live verification record — 2026-11-17 night (v0.7.0 + v0.7.1, publish live results)

Deployment: https://meetsync-roan.vercel.app, Supabase project `rgihmbpijneqzqltiqpp`, `VITE_PLACES_PROVIDER=photon` + `VITE_ROUTING_PROVIDER=osrm`. Migrations 0008 (osm_id) + 0009 (published_rank) applied by the user via Dashboard SQL Editor and verified via REST (column selects return 200); `publish-results` deployed via CLI (no-JWT call returns 401). Browsers: cloud browser default profile (Host P) + separate "Guest B" profile `pcecc08bfba1c`. All times IST, 2026-11-17. This run CLOSES the "known product gap" recorded in the v0.6.3 section above: live results are now votable and finalizable.

### Room WC7E75 — "Live test publish" (v0.7.0, ~23:29–23:35)

- §7.9 steps 1–2: Host P (Indiranagar preset) ran a Balanced/Café search (~60 s): "Live results · 30 places found, 12 routed, 5 ranked · places via photon.komoot.io". Ranked: Gloria Jean's, Kopitiam Lah, Neon Market, Nuage Pâtisserie & Café, Omira. The "Add these places to the vote" button showed with "Everyone in the room will see them on Compare & vote." One click → "Added to the vote — 5 places now on Compare & vote." + "Published ✓ — view on Compare & vote". No errors. The stale banner appeared after publishing (version moved) — correct.
- §7.9 step 3 / §8.10 step 1: Guest B (Koramangala, joined after the search) had Compare open WITHOUT reloading: baseline showed exactly the 3 Demo spots. After the publish, Gloria Jean's + Kopitiam Lah appeared live with "Live place" badges — but see the defect below.
- DEFECT FOUND (v0.7.0) + FIXED (v0.7.1): Guest B's Compare showed "top 5 of 8" as 3 demo spots + 2 live spots; Neon Market, Nuage, and Omira were excluded and unvotable (a reload changed nothing). Cause: `selectComparedSpots` capped at 5 and ordered unvoted spots by creation order (seeded first); only the publisher saw all 5 via per-browser engine order. Fix (v0.7.1, commit eda3de9): migration 0009 `published_rank` + shared published order in `selectComparedSpots`. Verified in room 69S8W8 below.
- §7.9 steps 5–6 / §8.10: Guest B saved Gloria Jean's #1 / Kopitiam Lah #2 (closest live-first ranking possible under the defect) — "Your ranking was saved. Saving again replaces it — you always have one active vote."; Gloria Jean's became "Group winner" (1 first-choice · Borda 4). Host saw the tally live without reload. Host finalized Gloria Jean's (confirm dialog → auto-navigate): announcement "Meeting point locked in: Gloria Jean's — 100 Feet Road(S K Karim Khan Road), Indiranagar, Bengaluru / Finalized by host at 17/11/2026, 23:34:43." Final Navigation showed the "Live place" badge + coordinates, NO rating/price/open-now; ETAs Host P 1.0 km · 1 min, Guest B 6.3 km · 7 min; directions links on the host's own row only.

### Room 69S8W8 — "Live test shared rank" (v0.7.1, ~23:43–23:48; bundle `assets/index-DwW4mbns.js`, verified to contain `publishedRank`)

- §7.9 step 4 / §8.10 step 2 (SHARED ORDER): Host P published the same 5 cafés in the same ranked order. Guest B joined fresh (Koramangala, NO search ever run in that browser — no engine order) and opened Compare: "Showing the top 5 of 8 spots", ALL FIVE live spots in EXACT ranked order (Gloria Jean's, Kopitiam Lah, Neon Market, Nuage Pâtisserie & Café, Omira), all "Live place", no demo spots in the top 5, no rating/price/open-now on any live spot. Reload-persistence was NOT separately exercised; the fresh-join evidence (order present with no session state at all) covers the server-authoritative claim.
- §7.9 step 8 / §8.10 step 4 (SUPERSEDE): Host ran a second search (Restaurant, 2 participants) and published: Tamarind House, Bharatiya Jalpan, Big Mummy, Kitchen Ministry, The Biriyani World. Guest B's Compare — WITHOUT a reload — updated live to "top 5 of 13 spots" with EXACTLY the new batch in ranked order; the café batch no longer leads.
- §8.10 step 3: after each publish, the host's own results showed the stale banner while the "Published ✓" state stayed visible — correct.
- Corrected observation (NOT a bug): an early note said Nuage Pâtisserie & Café lacked the "Café" chip. A careful re-check on the Routes page (enlarged screenshot, character by character) confirmed the pill reads exactly "Café" — the first report was a text-extraction miss, not a rendering defect. The code paths agree (Photon `osm_key=amenity/osm_value=cafe` → label "Café" via both the feature tags and the include-category fallback).
- NOT run: §7.9 step 7 (re-publish dedup / same ids / vote stability), §7.9 step 9 (finalized-room negative + direct 409), §8.10 step 5 (SQL check of `decision_version` +1 per publish, `published_rank` 1..N, old batch NULL). These need a SQL Editor session or a dedicated re-publish run.

## Live verification record — 2026-11-18 early hours (v0.7.2 + v0.7.3, map follows search + empty rooms + map fit)

Deployment: https://meetsync-roan.vercel.app, Supabase project `rgihmbpijneqzqltiqpp`, `VITE_PLACES_PROVIDER=photon` + `VITE_ROUTING_PROVIDER=osrm`. Bundles: v0.7.2 `assets/index-CqW13ydd.js` (verified to contain the `preview/` marker); v0.7.3 `assets/index-BGIV3IBb.js` (verified to contain the new empty-state copy). `create-room` redeployed as v4 (no-JWT call returns 401); no migration needed for v0.7.3. Browsers: cloud browser default profile (Host P, Connaught Place preset) + separate "Guest B" profile `pcecc08bfba1c` (Muradnagar, manual coordinates 28.8317, 77.5104). All times IST, 2026-11-18.

Context: the user reported from his own room PCGFCP (host in Muradnagar, Ram at Connaught Place) that after a correct Metro-station search (Sahibabad Junction #1), the Routes map showed routes to the seeded Bengaluru demo café with 2000+ km distances. Cause: the map selection latched to the first room spot and the search panel had no connection to it. v0.7.2 (commit e0c96ed) added search-result previews; the v0.7.2 run below found the fit defect, fixed in v0.7.3 (commit 9ea2cd0) together with the removal of demo-spot seeding (user-confirmed).

### Room YVNJ6B — "Live test map follows search" (v0.7.2, ~00:18–00:26)

- Baseline reproduced before the search: both browsers' map header read "Map — routes to The Blue Bean Café"; Guest B's distance to it ≈ 2,076 km.
- §7.9 step 10 (map follows the search): Host P ran a Metro-station search (Balanced, consented, ~60 s). Ranked: Shaheed Sthal, Naya Ghaziabad, Ghaziabad Junction, Sahibabad Junction, Noida Electronic City. Map header became "Map — routes to Shaheed Sthal" with legend Host P 27.9 km · 25 min, Guest B 24.3 km · 29 min. Tapping result #3 (Ghaziabad Junction) moved the header, the selected ring, and the legend (30.5 km · 28 min / 26.9 km · 33 min). Tapping the room card "The Blue Bean Café" restored its header and cleared the result ring. Publishing once showed "Added to the vote — 5 places now on Compare & vote." + "Published ✓". Stale banner appeared after publishing — correct.
- DEFECT FOUND (v0.7.2) + FIXED (v0.7.3): after the search the map stayed on the whole-of-India view (500 km scale bar) instead of framing Delhi. Cause: `fitToPoints` framed ALL spots including the far-away unselected Bengaluru ones. Fix (v0.7.3): `fitPointsForSelection` — fitKey changes frame participants + the selected spot only; initial fit, animation fit, and "Fit all" still frame everything. Verified in room KVCD2N and the YVNJ6B recheck below.
- ANOMALY (cause unknown, NOT reproduced on v0.7.3): after tapping The Blue Bean Café, the map ended at 10 m scale showing a blank beige canvas with no markers or route lines. The recheck below (same room, same tap, v0.7.3 build) settled on a correct wide view instead. No cause was established from the evidence; the observation is recorded here, not claimed as fixed by any specific change.

### Room KVCD2N — "v073 empty fit test" (v0.7.3, ~00:36–00:45)

- §7.9 step 11 (new room starts empty): the fresh room had ZERO spots in both browsers. Routes showed "No meeting spots yet" with the search+publish guidance, a working search panel, and a map with participant markers only (HP alone before the join; HP + GB after, Delhi area, 5 km scale). Compare showed "No spots to compare" with guidance, "0 of 1 participants voted", and a disabled "Finalize: no votes yet" button — no usable finalize, no crash. Lobby rendered normally with no spots content. Minor note: on one return to the Lobby the tab pills were not visible (the bottom "Discover routes →" link still navigated) — unverified whether a rendering or observation artifact.
- Search + fit (§7.9 steps 10 + 12): Host P's Metro search returned the same 5 stations with identical scores/order in both browsers when Guest B ran his own search (Shaheed Sthal 22.8, Naya Ghaziabad 24.5, Ghaziabad Junction 25.9, Sahibabad Junction 26.7, Noida Electronic City 28.7). After each search the map header read "routes to Shaheed Sthal" and the framing was 5 km scale at Delhi street level (Delhi/Noida/Ghaziabad/Muradnagar labels, NH roads), both participant markers + the spot pin + both OSRM route lines visible. Tapping #3 reframed on Ghaziabad Junction (ring + legend followed) with the framing unchanged at 5 km.
- Publish + Compare: "Added to the vote — 5 places now on Compare & vote." + stale banner. Compare showed all 5 in ranked order with "Live place" badges and no rating rows. Guest B's own search did NOT leak its preview onto Compare: exactly the 5 published places, no duplicates, no demo spots.
- Vote + finalize from published-only spots: Host P saved the ranking as shown (Shaheed Sthal #1) — "Your ranking was saved…", "1 of 2 participants voted", "Group winner" badge, finalize enabled. Host finalized Shaheed Sthal (confirm dialog → auto-navigate): announcement "Meeting point locked in: Shaheed Sthal — Grand Trunk Road, Ghaziabad / Finalized by host at 18/11/2026, 00:44:39." Guest B saw the identical announcement without reloading, with per-participant OSRM times (27.9 km · 25 min / 24.3 km · 29 min), directions links on his own row only, and "0 of 2 arrived". No invented rating/price/open-now anywhere; Navigate map at 5 km scale.

### Room YVNJ6B recheck — fit behaviour on the old room (v0.7.3, ~00:42–00:44)

- After reload (new build): header "routes to The Blue Bean Café", settled at 1000 km scale — whole of India WITH tiles loaded, Delhi + Bengaluru markers and the Delhi→Bengaluru route line visible.
- Tapping "Ghaziabad Junction" (published Delhi spot): 5 km scale, Delhi streets, markers + route visible, selected ring on the card.
- Tapping "The Blue Bean Café": settled at 300 km scale framing BOTH Delhi and Bengaluru with the route line visible — the 10 m blank view did NOT recur.
- "Fit all": 300 km, everything in view (Delhi cluster + all spots). Minor cosmetic: the Delhi markers sit partly clipped at the map's top edge in this extreme cross-country view.
- The 10 m blank-zoom observation from the v0.7.2 run is therefore NOT REPRODUCED on v0.7.3; its cause remains unknown.

### Known, disclosed, unchanged by this run

- The Routes spot list orders by straight-line × 1.3 estimates while search cards use OSRM road times, so the two orders/times differ for the same places (e.g. Shaheed Sthal: 25.4 km · 1 h 6 min on the spot card vs 27.9 km · 25 min on the search card; Sahibabad Junction led the spot list while Shaheed Sthal led the search). The Routes page copy discloses the estimate formula. Live OSRM estimates for all room spots remain a future improvement (the `route_estimates` table is reserved for it).
- Metro-station searches label results "Railway station" (Photon tags cannot distinguish metro from mainline stations; honest, documented approximation in ENGINE.md).
- NOT run (unchanged): §7.9 step 7 (re-publish dedup), §7.9 step 9 (finalized-room negative + direct 409), §8.10 step 5 (SQL check of version/ranks).
