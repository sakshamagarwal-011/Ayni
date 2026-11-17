import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner } from './ErrorBanner';
import {
  isActionAllowed,
  isOptimizationStale,
  isRoomExpired,
  saveEngineSpotOrder,
} from '../coordination';
import {
  CATEGORY_LABELS,
  EngineError,
  MEETING_CATEGORIES,
  OPTIMIZATION_PREFERENCES,
  PREFERENCE_LABELS,
  createDemoEngineRoutingAdapter,
  createMockPlacesClient,
  createOsrmEngineRoutingAdapter,
  createOverpassClient,
  getEngineConfig,
  resolveEngineMode,
  runOptimization,
  type CandidatePlace,
  type MeetingCategory,
  type OptimizationPreference,
  type OptimizationResult,
  type ParticipantOrigin,
} from '../engine';
import { formatDistance, formatDuration, osmDirectionsUrl } from '../lib/utils';
import { MODE_LABELS } from '../lib/distance';
import { getMapConfig } from '../map/config';
import { getDefaultRoutingClient } from '../map/routing';
import type { RoomDetail, TravelMode } from '../types';

/**
 * Smart meeting-point search panel (Route Discovery, additive section).
 *
 * Runs the open-source optimization engine (Overpass places + OSRM
 * road routing in live mode; mock places + demo estimates in demo
 * mode) and renders the top 5 with explanations. Engine failures show
 * an error banner here only — the existing spot list below is never
 * hidden or replaced.
 *
 * Consent model: the checkbox below is the runner's consent to send
 * coordinates to the places/routing endpoints. Other room members
 * consented by sharing a location in the room for meeting-point
 * search (see ENGINE.md). The travel mode selector on this page
 * applies to every participant in the search.
 */

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function OptimizationPanel({ detail, mode }: { detail: RoomDetail; mode: TravelMode }) {
  const [preference, setPreference] = useState<OptimizationPreference>('balanced');
  const [category, setCategory] = useState<MeetingCategory>('cafe');
  const [maxTravel, setMaxTravel] = useState('');
  const [meetingTime, setMeetingTime] = useState(() => toLocalInputValue(new Date(Date.now() + 2 * 60 * 60 * 1000)));
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const engineConfig = useMemo(() => getEngineConfig(), []);
  const mapConfig = useMemo(() => getMapConfig(), []);
  const resolved = useMemo(
    () => resolveEngineMode(engineConfig, mapConfig.routingProvider, mapConfig.routingEnabled),
    [engineConfig, mapConfig],
  );

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const displayNameById = useMemo(
    () => new Map(detail.participants.map((p) => [p.id, p.displayName])),
    [detail.participants],
  );

  // Optimization runs are blocked once the room is finalized or
  // expired — the decision is already made (or gone).
  const optimizeCheck = isActionAllowed(detail.room.status, 'optimize', {
    isExpired: isRoomExpired(detail.room),
  });
  const stale = result ? isOptimizationStale(result, detail.room, detail.participants) : null;

  async function runSearch() {
    setError(null);
    setResult(null);
    if (!optimizeCheck.allowed) {
      setError(optimizeCheck.reason ?? 'Optimization is not available for this room.');
      return;
    }
    if (resolved.mode === 'disabled') {
      setError(resolved.reason);
      return;
    }
    if (!consent) {
      setError('Please tick the consent checkbox before running a search.');
      return;
    }
    const currentId = detail.currentParticipantId;
    if (!currentId) {
      setError('Join this room first, then run a search. Your location is needed as a starting point.');
      return;
    }
    const parsedMeeting = new Date(meetingTime);
    const meetingTimeISO = Number.isNaN(parsedMeeting.getTime()) ? meetingTime : parsedMeeting.toISOString();
    const origins: ParticipantOrigin[] = detail.participants
      .filter((p) => p.location)
      .map((p) => ({
        participantId: p.id,
        displayName: p.displayName,
        lat: p.location!.lat,
        lng: p.location!.lng,
        mode,
        required: true,
        locationUpdatedAt: p.location!.updatedAt,
        locationExpiresAt: p.location!.expiresAt,
        // Runner: explicit checkbox. Others: room consent model (see header comment).
        consentGiven: p.id === currentId ? consent : true,
      }));
    const maxTravelMinutes = maxTravel.trim() === '' ? undefined : Number(maxTravel);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const live = resolved.mode === 'live';
      const demoPlaces: CandidatePlace[] = detail.spots.map((s) => ({
        osmId: `mock/${s.id}`,
        name: s.name,
        category: s.category,
        lat: s.location.lat,
        lng: s.location.lng,
        address: s.address,
        source: 'mock',
      }));
      const outcome = await runOptimization(
        {
          roomId: detail.room.id,
          roomStatus: detail.room.status,
          decisionVersion: detail.room.decisionVersion,
          currentParticipantId: currentId,
          memberParticipantIds: detail.participants.map((p) => p.id),
          requiredParticipantIds: detail.participants.map((p) => p.id),
          origins,
          category,
          meetingTimeISO,
          preference,
          maxTravelMinutes,
          maxCandidates: engineConfig.maxCandidates,
        },
        {
          placesClient: live
            ? createOverpassClient({ baseUrl: engineConfig.overpassUrl, timeoutMs: engineConfig.overpassTimeoutMs })
            : createMockPlacesClient(demoPlaces),
          routingClient: live
            ? createOsrmEngineRoutingAdapter(getDefaultRoutingClient())
            : createDemoEngineRoutingAdapter(),
          placesPerArea: engineConfig.placesPerArea,
          maxOsrmRequests: engineConfig.maxOsrmRequests,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setResult(outcome);
        // Demo-mode candidates are the room's spots (osmId "mock/<spot
        // id>"). Persist their ranked order so the comparison page can
        // show the engine top-5 in engine order. The stored order is
        // validated against the decision version on read, so a stale
        // order is never reused after the room changes.
        const spotIds = outcome.ranked
          .map((entry) =>
            entry.candidate.source === 'mock' && entry.candidate.osmId.startsWith('mock/')
              ? entry.candidate.osmId.slice('mock/'.length)
              : null,
          )
          .filter((id): id is string => id !== null && detail.spots.some((s) => s.id === id));
        if (spotIds.length > 0) {
          try {
            if (typeof sessionStorage !== 'undefined') {
              saveEngineSpotOrder(sessionStorage, detail.room.id, {
                spotIds,
                decisionVersion: detail.room.decisionVersion,
                generatedAt: new Date().toISOString(),
              });
            }
          } catch {
            // Storage unavailable — the comparison page falls back to
            // tally order.
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof EngineError) setError(err.userMessage);
      else setError(err instanceof Error ? err.message : 'The search failed. Try again.');
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  return (
    <section className="glass-card space-y-4 p-4 sm:p-5" aria-label="Smart meeting point search">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-white">Smart meeting points</h2>
        {resolved.mode === 'live' ? (
          <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-medium text-emerald-200">
            Live · Overpass + OSRM
          </span>
        ) : resolved.mode === 'demo' ? (
          <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-200">
            Demo search
          </span>
        ) : (
          <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs text-slate-300">Disabled</span>
        )}
      </div>
      <p className="text-sm text-slate-300">
        Finds real nearby places and ranks the top 5 by road travel time for everyone. {resolved.reason} Ranking uses
        road-network times only — never straight-line distance. See ENGINE.md for the scoring formulas and limits.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="opt-strategy" className="label">
            Optimization strategy
          </label>
          <select
            id="opt-strategy"
            className="input-field"
            value={preference}
            onChange={(e) => setPreference(e.target.value as OptimizationPreference)}
          >
            {OPTIMIZATION_PREFERENCES.map((p) => (
              <option key={p} value={p}>
                {PREFERENCE_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="opt-category" className="label">
            Meeting category
          </label>
          <select
            id="opt-category"
            className="input-field"
            value={category}
            onChange={(e) => setCategory(e.target.value as MeetingCategory)}
          >
            {MEETING_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="opt-maxtravel" className="label">
            Max travel time (minutes, optional)
          </label>
          <input
            id="opt-maxtravel"
            className="input-field"
            inputMode="numeric"
            placeholder="e.g. 45"
            value={maxTravel}
            onChange={(e) => setMaxTravel(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="opt-time" className="label">
            Meeting time
          </label>
          <input
            id="opt-time"
            type="datetime-local"
            className="input-field"
            value={meetingTime}
            onChange={(e) => setMeetingTime(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-400">Times are static road times — no traffic model.</p>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-200">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-violet-500"
        />
        <span>
          I consent to sharing my location for this search. In live mode, participant coordinates are sent to the
          Overpass and OSRM public servers to find places and compute road routes. Locations expire after 2 hours.
        </span>
      </label>

      <div>
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={running || resolved.mode === 'disabled' || !optimizeCheck.allowed}
          className="btn-primary"
        >
          {running ? 'Searching…' : 'Find best meeting points'}
        </button>
        {!optimizeCheck.allowed && (
          <p className="mt-2 text-xs text-slate-400" role="status">
            {optimizeCheck.reason}
          </p>
        )}
        {running && (
          <p className="mt-2 text-xs text-slate-400" role="status">
            Searching places and computing road routes… Live routing is throttled to about 1 request per second, so
            larger searches take a little while.
          </p>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      {result && stale?.stale && (
        <div role="status" className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          Stale — the room changed since this search. Re-run to get current results.
          {stale.reason ? ` ${stale.reason}` : ''}
        </div>
      )}

      {result && (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            {result.provider === 'osrm' ? 'Live results' : 'Demo results'} · {result.stats.discovered} places found,{' '}
            {result.stats.considered} routed, {result.ranked.length} ranked
            {result.excluded.length > 0 ? `, ${result.excluded.length} excluded` : ''}.
          </p>
          {result.warnings.map((w) => (
            <p key={w} className="text-xs text-amber-200">
              {w}
            </p>
          ))}
          {result.ranked.length === 0 && (
            <p className="text-sm text-slate-300">
              No places passed the filters. Try removing the max-travel limit or choosing a different category.
            </p>
          )}
          {result.ranked.map((entry) => (
            <article key={entry.candidate.osmId} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-2.5 py-0.5 text-xs font-bold text-white">
                  #{entry.rank}
                </span>
                <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-xs text-slate-200">
                  {entry.candidate.category}
                </span>
                <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-xs text-slate-200">
                  Score {entry.score.toFixed(1)}
                </span>
                {entry.candidate.source === 'mock' && (
                  <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-200">
                    Demo spot
                  </span>
                )}
              </div>
              <h3 className="mt-2 text-base font-semibold text-white">{entry.candidate.name}</h3>
              {entry.candidate.address && <p className="text-sm text-slate-300">{entry.candidate.address}</p>}
              <p className="mt-1 text-xs text-slate-400">
                {entry.candidate.lat.toFixed(4)}, {entry.candidate.lng.toFixed(4)} · OSM {entry.candidate.osmId}
              </p>
              <p className="mt-2 text-sm text-slate-200">{entry.explanation}</p>
              <ul className="mt-3 space-y-1.5">
                {entry.perParticipant.map((r) => (
                  <li key={r.participantId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-slate-200">
                      {displayNameById.get(r.participantId) ?? r.participantId}{' '}
                      <span className="text-xs text-slate-400">({MODE_LABELS[r.mode].toLowerCase()})</span>
                    </span>
                    <span className="text-slate-300">
                      {r.reachable && r.durationMin !== null && r.distanceM !== null
                        ? `${formatDistance(r.distanceM)} · ${formatDuration(r.durationMin)}`
                        : 'Unreachable'}
                    </span>
                  </li>
                ))}
              </ul>
              <a
                href={osmDirectionsUrl(null, { lat: entry.candidate.lat, lng: entry.candidate.lng })}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block text-sm font-medium text-violet-300 hover:text-violet-200"
              >
                Directions in OpenStreetMap ↗
              </a>
            </article>
          ))}
          {result.excluded.length > 0 && (
            <details className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-200">
                {result.excluded.length} excluded place{result.excluded.length === 1 ? '' : 's'} — why?
              </summary>
              <ul className="mt-3 space-y-2 text-sm text-slate-300">
                {result.excluded.map((e) => (
                  <li key={e.candidate.osmId}>
                    <span className="font-medium text-white">{e.candidate.name}</span> — {e.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
