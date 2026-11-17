# Group coordination — MeetSync 3D

How voting, finalization, ETA/navigation, arrival, expiry, and reconnect work — the rules, where they are enforced, and what is still unverified live. This document describes the coordination layer delivered after Phases 1–4; the layout and screens were not changed (additive features only, inside existing containers).

> **Navigation links: OpenStreetMap + `geo:`, not Google.** The original coordination request asked for "Google Maps navigation links". The user explicitly chose **open-source only** (see MEMORY/preferences and MAPS.md), so per-participant navigation links are **OpenStreetMap directions + `geo:` device links**, reusing the existing `osmDirectionsUrl` / `geoUrl` pattern. There is no `google.com/maps` URL, Google SDK, or Google API reference anywhere in `src/` — the zero-Google grep in TESTING.md §5.10 must keep passing. If this interpretation is wrong, the user will correct it; until then, do not add Google links.

## 1. State machine

States are exactly the `meeting_rooms.status` CHECK set from migration 0001 — no new states were added:

```
lobby ──► discovering ──► comparing ──► finalized
  │            │              │
  └────────────┴────► comparing (direct; flows may skip discovering)
  │            │              │
  └────────────┴──────────────┴──► expired   (system only, on expires_at)
```

Rules (`src/coordination/stateMachine.ts`, pure — no service imports):

| Transition | Who | Extra guard |
|---|---|---|
| `lobby → discovering`, `discovering → comparing`, `lobby → comparing` | member (or system) | not expired |
| `* → finalized` (from any open state) | **host only**, member | spot required, not expired |
| `* → expired` (from any non-finalized state) | **system only** | on `expires_at` passing |
| out of `finalized` or `expired` | nobody | terminal — no transitions out |

`finalized` is terminal for decisions: no re-finalize, and votes cannot change the outcome after finalization (voting is closed; the finalized destination keeps showing). `expired` blocks join, vote, finalize, optimize, location updates, and arrival.

`isActionAllowed(status, action, context)` is the single rule set used by the UI (disable + explain), the mock service, and the Supabase service guards. The Edge Functions enforce the same rules server-side; RLS is the final backstop (no direct `meeting_rooms` writes at all).

Action rules:

| Action | Allowed when |
|---|---|
| `vote` | open status, member, not expired. Closed once finalized. |
| `finalize` | open status, host, not expired. |
| `optimize` | open status, member, not expired. Blocked once finalized/expired. |
| `publish` | same rules as `optimize` (open status, member, not expired). Publishes live search results as votable spots; blocked once finalized/expired. Added in v0.7.0 — see §2.1. |
| `join` | open status **or finalized** (view-only: a late joiner sees the announcement and can navigate, but cannot vote or change the outcome). Blocked when expired. |
| `updateLocation` | member, any non-expired status **including finalized** (navigation needs fresh locations). |
| `arrive` | finalized only, member only. |

Status advances today are: create → `lobby`, finalize → `finalized` (Edge Function), expiry → `expired` (system / cleanup). `discovering` / `comparing` are informational states in the CHECK set; nothing depends on a page-view write to advance status, and all guards treat the three open states uniformly.

## 2. Voting

**Semantics: one active ranking per participant.** A vote is a ranked list over the compared spots. Saving replaces the previous ranking: the Supabase service deletes the participant's existing votes for the room and inserts the new ranking (relying on the unique constraint on `votes(room_id, participant_id, spot_id)`), then refetches; the mock service mirrors the same replace semantics on its local store. Saving twice never creates duplicate active votes.

**Validation.** The UI validates a full permutation of the compared set (`validateRanking`); the service validates a non-empty, duplicate-free subset of the room's spots (`validateVoteSubmission`) and verifies membership before deleting. Empty, duplicate, and unknown-spot rankings are rejected with `VOTE_FAILED`.

**Compared set: at most 5 spots** (`selectComparedSpots`). Ordering precedence: (1) the sessionStorage engine order when present and valid (stored by the Route Discovery panel, validated against the room's decision version on read — a stale order is ignored); (2) the SHARED published order — spots with a non-null `publishedRank` lead in rank order, so every participant sees the latest published batch first even without an engine order (v0.7.1; before this, non-publishers saw creation order and published spots beyond the cap were unvotable); (3) group tally order. The remainder after any leading order follow by group tally. When capped, the UI shows a "Showing top 5" note.

### 2.1 Publishing live results (v0.7.0)

`publishResults(roomId, places)` turns a live search's ranked top 5 into votable `candidate_spots` rows via the `publish-results` Edge Function (migrations 0008 + 0009). Only live results may be published — demo results are the room's spots already. The function upserts by `(room_id, osm_id)` (partial unique index; select-then-write, since the JS client cannot target a partial index with `ON CONFLICT`), so re-publishing keeps row ids stable and votes are never stranded. A room with 30 spots already cannot publish more (409 `SPOT_LIMIT`).

**Version-bump semantics.** Publishing increments `decision_version` by 1 (plain +1, no optimistic lock — concurrent publishes are idempotent and must not 409 each other), conditional on the room still being open, BEFORE the spot writes. The bump is the propagation signal: `candidate_spots` is not in the Realtime publication, so the room-row change is what makes every open page refetch the detail including the new spots. Note the side effect: a publish makes the publisher's own search result read as stale (the version moved) — that is correct, the room did change — and the publish UI switches to its published state rather than offering a blind re-publish.

**Shared published order (v0.7.1).** The function writes `published_rank` (1..N, submitted order; migration 0009) onto the published rows and clears it on every other spot in the room, so a re-publish SUPERSEDES the previous batch: old-batch spots fall back to tally order. The rank is server-authoritative and shared — every browser's Compare page leads with the latest batch in rank order. The sessionStorage engine order still takes precedence when present (the publisher's own view + demo mode), but it is no longer the only way the published order reaches other participants. Ordering is a display hint only in both cases — it never decides finalization (the group winner does).

**Tally** (`src/coordination/voting.ts`, pure): per spot — first-choice count, Borda score (rank *r* in a set of *N* earns *N − r* points), average rank, voter count. **Group winner** tie-breaks, in order: most first-choice votes → highest Borda score → lowest average rank → spot name (A–Z). Deterministic; no randomness.

**Privacy choice.** Under current RLS, members *can* SELECT all votes in their room (the tally needs them). The UI deliberately shows **only aggregates + your own ranking** — never another participant's full ranking. Voter participation ("3 of 4 voted") is shown without revealing who ranked what.

**Realtime voting updates.** `votes` and `participant_locations` were added to the Realtime publication (migration 0005, guarded `DO` blocks) and `subscribeToRoom` in both services watches four tables: `participants`, `meeting_rooms`, `votes`, `participant_locations`. `useRoomDetail` refetches the room (and the comparison page refetches votes) when an event fires, coalesced with a **300 ms debounce** so rapid vote/location bursts do not cause refetch storms. No polling, no duplicate channels per page. Demo mode has no Realtime; votes update locally.

**Finalization uses the group winner** (see §3), never the clicker's #1.

## 3. Finalization (host-only, version-guarded)

- **Host-only control.** Only the host sees enabled finalize controls. The main button finalizes the group winner by default; each compared spot also has a small host-only "Finalize this spot (host)" action. Non-hosts see the control disabled with "Only the host can finalize" text. The server is the real guard (Edge Function verifies host membership; RLS forbids direct writes) — the UI state is presentation, not security.
- **Inline confirm.** No browser `confirm()`: an inline card asks "Finalize \<spot\>? Everyone will see this destination." with Cancel/Confirm, plus loading and error states.
- **Optimistic locking.** `finalizeMeeting(roomId, spotId, expectedDecisionVersion?)` — the optional third parameter is backward compatible. The Edge Function rewrites the room in **one conditional update** (`decision_version = current`, `decision_version + 1`, `finalized_at = now`, `status = 'finalized'`, `finalized_spot_id`); a 0-row update means a concurrent finalization won, and returns 409. A supplied version that does not match the current version returns 409 `STALE_VERSION`. An already-finalized room returns 409 `ALREADY_FINALIZED` naming the spot. An expired room returns 410. The mock service mirrors all guards (host check via the current-participant map, state, expiry, version).
- **Stale-result handling in the UI.** On 409 stale/already-finalized, the UI refetches the room and shows the *current* destination instead of erroring blindly.
- **Single source of truth.** After finalization, every page derives the destination **only from `room.finalized_spot_id`** plus the spots list — never from local ranking or optimization state. The announcement banner (glass card, `role="status"`) appears on Lobby, Routes, Compare, and Navigate whenever the room is finalized: "Meeting point locked in: \<spot name\> — \<address\>. Finalized by host at \<time\>." with a link to Navigate. When the `meeting_rooms` row flips to finalized, open pages refetch via the existing subscription and show the banner without reload.
- **Same destination for everyone.** An integration test with two mock-service instances sharing one store asserts identical `finalized_spot_id` / spot name across readers after finalize (see `tests/integration/coordination.test.ts`).

## 4. ETA + individual navigation (privacy-guarded)

- **ETA helpers** (`src/coordination/eta.ts`, pure): `etaClockTime` / `etaLabel` produce "ETA 18:42 if leaving now (24 min)". The label always says **"if leaving now"** — no departure-time traffic model is invented; durations come from the routing/estimate layer.
- **Where ETAs appear:** per-participant ETA in the Final Navigation travel list, and a longest-ETA footer summary per spot in Compare (car mode, fresh locations only).
- **Individual navigation links — privacy rule.** In Final Navigation, navigation links appear **only on the current participant's own row**, built from their own fresh location: "Directions from my location (OpenStreetMap)" (`osmDirectionsUrl(ownLocation, spotLocation)`) and "Open with device maps (`geo:`)" for the spot. Other participants' rows show ETA/duration only — **no link containing their origin coordinates, no precise coordinates displayed for others** beyond the existing map/labels. The shared "Directions & sharing" section keeps **spot-only links** (no origin). Coordinates are never logged and never put in hrefs/URLs/clipboard for anyone but the viewer themselves. Enforced by `ownNavigationLinks` / `spotOnlyNavigationLinks` (`src/coordination/navigation.ts`) and covered by `tests/unit/navigationPrivacy.test.ts` + integration tests.
- **Expired locations** are excluded from ETA/navigation inputs and shown as "Location expired — ask them to update", with the stored label kept but no coordinates in new ETA/navigation UI.

## 5. Arrival confirmation (optional, reversible)

`confirmArrival(roomId, participantId, arrived)` on `RoomService` (both services). Supabase mode updates `participants.arrived_at` for the own row only (`.eq('id', …).eq('auth_uid', …)`); RLS + the privilege trigger enforce self-only updates server-side, and `arrived_at` is an allowed self-update column (migration 0005 documents the trigger recreation; it was never in the blocked set). Demo mode checks the current-participant map. Arrival is **optional and reversible** (tap again to clear), shown as "Arrived ✓" / "On the way" labels in Lobby and Final Navigation plus an arrival count ("2 of 4 arrived"). Arrival changes flow through the existing `participants` Realtime subscription. Non-members see no arrival data (RLS).

## 6. Expiry + cleanup

- **Frontend expiry** (`src/coordination/expiry.ts`, pure): `isRoomExpired` is true when status is `expired`, or when `expires_at` has passed **and the room is not finalized**. Finalized rooms are never auto-expired for display — every participant must keep seeing the same destination (server-side cleanup prunes old finalized rooms by age instead). All room pages show an expired-room state (banner + disabled actions + "Create a new meeting" link) reusing existing banner patterns; there is no separate expired page.
- **Cleanup Edge Function** (`cleanup-expired-locations`, cron-secret auth kept): deletes expired `participant_locations`, marks past-`expires_at` non-finalized rooms expired via `expire_rooms()`, and deletes expired/finalized rooms whose `expires_at` is older than the retention cutoff — default **7 days**, configurable via the `CLEANUP_RETENTION_DAYS` env var (clamped 1–90). It never deletes non-expired rooms. It returns counts (`deletedLocations`, `expiredRooms`, `prunedRooms`, `retentionDays`). Scheduling (Supabase Scheduled Functions / `pg_cron`) is documented in SUPABASE.md §10.
- **Demo mode:** `purgeExpiredDemoRooms()` runs best-effort on room loads (localStorage only, no network), mirroring the same rules: mark expired, prune rooms expired > 7 days ago.
- **Stale-optimization guard.** `OptimizationResult` is stamped with `decisionVersion` + `participantsSignature` (sorted participant ids + location `updatedAt` values, `src/engine/signature.ts` — shared by the orchestrator and the guard so they cannot drift) + `generatedAt`. `isOptimizationStale(result, room, participants)` is true when the room was finalized/expired since the search, the decision version changed, the participants signature changed, or a location expired. The optimization panel shows a "Stale — the room changed since this search. Re-run to get current results." banner, and optimization runs are blocked when the room is finalized/expired. **Finalize never consumes a stale result directly**: it always uses the current group winner / host-selected spot + the current decision version.

## 7. Disconnect / reconnect

`subscribeToRoom` (Supabase service) uses `createResilientSubscription` (`src/coordination/reconnect.ts`, pure helper with an injectable channel factory + scheduler so it is unit-testable without network):

- `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` → drop the dead channel, resubscribe with bounded exponential backoff **1s, 2s, 4s, 8s (cap), max 5 attempts**, then `error` status + manual Retry. No infinite retry, no polling.
- Window `online` → resubscribe immediately + refetch; `offline` → `offline` status + banner. `visibilitychange` (visible) → quiet refetch in `useRoomDetail` (no skeleton flicker; last good detail is kept on failure).
- Statuses: `RealtimeStatus` was extended with `offline` | `reconnecting` (all usages — `useRoomDetail` + Lobby — were updated; `realtimeLabel` covers the new statuses). The mock service's subscribe remains a no-op returning an unsubscribe function (no fake reconnect).
- Every room page surfaces connection status or a Retry path: Lobby has its status pill + error banner; Routes, Compare, and Navigate use the shared `RealtimeStatusBanner`.

Realtime events are coalesced with the 300 ms debounce described in §2.

## 8. Error handling

Typed errors (`src/coordination/errors.ts`): `CoordinationError` with a user-safe `userMessage` and a `code`. Edge Function HTTP statuses and RLS failures are mapped to these codes in the services (`parseEdgeFunctionError` reads the `{ error, code }` JSON body from `functions.invoke` failures; `inferCoordinationCode` falls back to message/status heuristics). No raw errors or stack traces ever reach the UI; every new UI action shows an `ErrorBanner` with Retry, disables buttons while pending, and never leaves a blank/spinner-only state.

| Code | Meaning | Typical source |
|---|---|---|
| `NOT_MEMBER` | Caller is not a participant (or not acting as themselves) | vote/arrival/finalize guards |
| `UNAUTHORIZED` | No/invalid auth (HTTP 401) | Edge Function auth guards |
| `NOT_HOST` | Caller is a member but not the host | 403, finalize guard |
| `NOT_FINALIZED` | Action requires a finalized room (e.g. arrival) | state-machine guard |
| `ALREADY_FINALIZED` | Room is already finalized (message names the spot) | 409, finalize/vote guards |
| `STALE_VERSION` | `expectedDecisionVersion` mismatch / concurrent finalization | 409 |
| `EXPIRED` | Room or link expired | 410, expiry guards |
| `OFFLINE` | Device offline / live connection down | connectivity listeners |
| `VOTE_FAILED` | Ranking invalid or could not be saved | validation, save failures |
| `UNKNOWN` | Anything else (message is still user-safe) | 500, unexpected errors, bare 403/409 |

Vote saves go through the atomic `replace_votes()` RPC (migration
0006): one transaction replaces the caller's ranking, enforcing
ownership, open room state, and spot membership server-side. A DB
trigger (`check_vote_validity`) plus a unique `(room_id,
participant_id, rank)` index enforce the same guards for any direct
vote write, so a member cannot vote in a finalized/expired room, use
cross-room ids, or submit duplicate ranks.

## 9. Database changes (migration 0005)

`supabase/migrations/20251117000005_0005_coordination.sql` (idempotent, backward compatible):

- `meeting_rooms.decision_version` (`int NOT NULL DEFAULT 1`, `>= 1` check), `meeting_rooms.finalized_at` (`timestamptz NULL`).
- `participants.arrived_at` (`timestamptz NULL`).
- Index on `(status, expires_at)` for the expiry scan.
- `expire_rooms()` function: marks past-`expires_at`, non-finalized rooms `expired`; finalized rooms are never auto-expired.
- Guarded Realtime publication adds for `votes` + `participant_locations`.
- Trigger recreation documenting `arrived_at` as an allowed self-update column (the blocked set is unchanged: id/room/auth/host/avatar/joined).
- No seed data, no policy breakage, RLS stays enabled. Frontend types (`MeetingRoom`, `Participant`) carry the new fields with safe defaults for old rows and mock data; both services' row mapping was updated.

## 10. What is verified vs pending

- **Verified offline:** 256 unit tests (state machine, voting, ETA, expiry, stale guard, navigation privacy, arrival, reconnect, error mapping, plus all pre-existing suites), 28 integration tests (16 coordination + 12 optimization, mocked services/channels, no network), production build, zero-Google / zero-service-role greps. RLS tests (11) skip gracefully without credentials.
- **PENDING (live):** two-browser coordination procedure in TESTING.md §8 — voting Realtime, host/non-host finalize, announcement, ETA/navigation privacy check, arrival, disconnect/reconnect, expiry, stale optimization. Migrations and Edge Functions await first live deployment (Deno/psql are not installed in the dev environment; they were verified by reading only). Do not claim live verification passed until §8 is run and recorded.
