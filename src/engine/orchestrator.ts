import { estimateDurationMin, haversineDistanceM } from '../lib/distance';
import { straightLineGeometry } from '../map/geo';
import { profileForMode, routeCacheKey, type OsrmClient, type RouteGeometry } from '../map/routing';
import {
  EngineNoPlacesError,
  EngineQuotaError,
  EngineUnavailableError,
  EngineError,
  OptimizationValidationError,
} from './errors';
import { deduplicatePlaces } from './places';
import type { PlacesClient } from './placesClient';
import { rankCandidates } from './ranking';
import { generateSearchAreas, spreadDiagonalKm } from './searchAreas';
import { signatureFromOrigins } from './signature';
import {
  CATEGORY_LABELS,
  type CandidatePlace,
  type OptimizationInput,
  type OptimizationResult,
  type ParticipantOrigin,
  type TravelResult,
} from './types';
import { optimizationWarnings, validateOptimizationInput } from './validation';

/**
 * Steps 1–10 orchestrator. Dependencies are injected so tests can run
 * the full flow against mocked places/routing responses with zero
 * network access.
 *
 * LIVE-PATH RULE: when routing is live (OSRM), a failed route is
 * `reachable: false` — never a straight-line fallback. If ALL route
 * requests fail, or place search fails, the run throws
 * EngineUnavailableError and NO ranked results are returned. The demo
 * path uses deterministic estimates and labels everything 'Demo'; the
 * two paths never mix.
 */

export interface EngineRoutingClient {
  /** 'osrm' = live road routing; 'demo' = deterministic estimates. */
  readonly kind: 'osrm' | 'demo';
  /** Strict route: null when unreachable/failed. Never falls back. */
  fetchRoute(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
    mode: ParticipantOrigin['mode'],
    signal?: AbortSignal,
  ): Promise<RouteGeometry | null>;
}

/** Adapter over the shared throttled/cached OSRM client (strict mode — no fallback). */
export function createOsrmEngineRoutingAdapter(client: OsrmClient): EngineRoutingClient {
  return {
    kind: 'osrm',
    fetchRoute: (from, to, mode, signal) => client.fetchRouteStrict(from, to, mode, signal),
  };
}

/** Demo adapter: deterministic local estimates, labelled 'mock' geometry. Demo path only. */
export function createDemoEngineRoutingAdapter(): EngineRoutingClient {
  return {
    kind: 'demo',
    fetchRoute: async (from, to, mode) => {
      const straightM = haversineDistanceM(from, to);
      return {
        coordinates: straightLineGeometry(from, to),
        distanceM: Math.round(straightM * 1.3),
        durationMin: estimateDurationMin(straightM, mode),
        source: 'mock',
        profile: 'estimate',
        transitApproximation: false,
      };
    },
  };
}

export interface OptimizationDeps {
  placesClient: PlacesClient;
  routingClient: EngineRoutingClient;
  /** Places requested per search area (default 30). */
  placesPerArea?: number;
  /** Max unique route pairs per run (default 60, live path only). */
  maxOsrmRequests?: number;
  now?: () => Date;
}

const DEFAULT_PLACES_PER_AREA = 30;
const DEFAULT_MAX_OSRM_REQUESTS = 60;

/** Max straight-line distance from a candidate to any required origin — geometry-only pre-filter ordering. */
function maxStraightLineKm(candidate: CandidatePlace, required: ParticipantOrigin[]): number {
  let max = 0;
  for (const origin of required) {
    const d =
      haversineDistanceM({ lat: origin.lat, lng: origin.lng }, { lat: candidate.lat, lng: candidate.lng }) / 1000;
    if (d > max) max = d;
  }
  return max;
}

export async function runOptimization(
  input: OptimizationInput,
  deps: OptimizationDeps,
  signal?: AbortSignal,
): Promise<OptimizationResult> {
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();

  // Step 1 — validate.
  const issues = validateOptimizationInput(input, now);
  if (issues.length > 0) throw new OptimizationValidationError(issues);
  const warnings: string[] = [...optimizationWarnings(input, now)];
  const required = input.origins.filter((o) => o.required);

  // Step 2 — search areas.
  const searchAreas = generateSearchAreas(input.origins);
  const diagonalKm = spreadDiagonalKm(input.origins);
  if (diagonalKm > 50) {
    warnings.push(
      `Participants are spread across ${diagonalKm.toFixed(0)} km, so the search uses 3 areas. Results may favour places near the group centre.`,
    );
  }
  if (input.origins.some((o) => o.mode === 'transit') && deps.routingClient.kind === 'osrm') {
    warnings.push('Transit trips use the driving profile (OSRM has no transit routing) and are approximations.');
  }
  warnings.push('Travel times are static road times with no traffic or departure-time model.');

  // Step 3 — discover places, one sequential request per area.
  const placesPerArea = deps.placesPerArea ?? DEFAULT_PLACES_PER_AREA;
  const discovered: CandidatePlace[] = [];
  let invalidRemoved = 0;
  let duplicatesRemoved = 0;
  try {
    for (const area of searchAreas) {
      const result = await deps.placesClient.search(area, input.category, placesPerArea, signal);
      discovered.push(...result.places);
      invalidRemoved += result.dropped;
      duplicatesRemoved += result.duplicatesRemoved;
    }
  } catch (err) {
    if (err instanceof EngineError) throw err;
    throw new EngineUnavailableError('places');
  }

  // Step 4 — deduplicate across areas by OSM id; invalid places were already removed by the parser.
  const deduped = deduplicatePlaces(discovered);
  duplicatesRemoved += deduped.duplicatesRemoved;
  const unique = deduped.places;
  if (unique.length === 0) {
    throw new EngineNoPlacesError(
      CATEGORY_LABELS[input.category].toLowerCase(),
      `within ${searchAreas.map((a) => `${a.radiusKm.toFixed(1)} km of the group centre`).join(', ')}`,
    );
  }

  // Pre-filter (geometry only): cap OSRM work before routing. Final
  // ranking uses road durations only — see ENGINE.md.
  const maxCandidates = input.maxCandidates ?? 12;
  let considered = unique;
  if (unique.length > maxCandidates) {
    const ordered = [...unique]
      .map((candidate) => ({ candidate, maxKm: maxStraightLineKm(candidate, required) }))
      .sort((a, b) => a.maxKm - b.maxKm || a.candidate.name.localeCompare(b.candidate.name));
    considered = ordered.slice(0, maxCandidates).map((o) => o.candidate);
    warnings.push(
      `Pre-filtered ${unique.length} places to the ${maxCandidates} nearest by straight-line distance before routing; final ranking uses road travel times only.`,
    );
  }

  // Steps 5–6 — route batches grouped by OSRM profile, deduplicated pairs.
  interface Pair {
    origin: ParticipantOrigin;
    candidate: CandidatePlace;
    key: string;
    profile: string;
  }
  const pairByKey = new Map<string, Pair>();
  for (const origin of input.origins) {
    for (const candidate of considered) {
      const { profile } = profileForMode(origin.mode);
      const key = routeCacheKey(
        { lat: origin.lat, lng: origin.lng },
        { lat: candidate.lat, lng: candidate.lng },
        profile,
      );
      if (!pairByKey.has(key)) {
        pairByKey.set(key, { origin, candidate, key, profile });
      }
    }
  }
  const pairs = [...pairByKey.values()].sort(
    (a, b) => a.profile.localeCompare(b.profile) || a.key.localeCompare(b.key),
  );
  const maxOsrmRequests = deps.maxOsrmRequests ?? DEFAULT_MAX_OSRM_REQUESTS;
  if (deps.routingClient.kind === 'osrm' && pairs.length > maxOsrmRequests) {
    throw new EngineQuotaError(pairs.length, maxOsrmRequests);
  }

  const geometryByKey = new Map<string, RouteGeometry | null>();
  let routeFailures = 0;
  for (const pair of pairs) {
    const geometry = await deps.routingClient.fetchRoute(
      { lat: pair.origin.lat, lng: pair.origin.lng },
      { lat: pair.candidate.lat, lng: pair.candidate.lng },
      pair.origin.mode,
      signal,
    );
    geometryByKey.set(pair.key, geometry);
    if (!geometry) routeFailures += 1;
  }
  if (deps.routingClient.kind === 'osrm' && pairs.length > 0 && routeFailures === pairs.length) {
    throw new EngineUnavailableError('routing');
  }

  // Build travel results. Live failures stay unreachable — no fallback.
  const source = deps.routingClient.kind === 'osrm' ? 'osrm' : 'demo';
  const resultsByCandidate = new Map<string, TravelResult[]>();
  for (const candidate of considered) {
    const results: TravelResult[] = [];
    for (const origin of input.origins) {
      const { profile } = profileForMode(origin.mode);
      const key = routeCacheKey(
        { lat: origin.lat, lng: origin.lng },
        { lat: candidate.lat, lng: candidate.lng },
        profile,
      );
      const geometry = geometryByKey.get(key) ?? null;
      results.push({
        participantId: origin.participantId,
        candidateId: candidate.osmId,
        mode: origin.mode,
        durationMin: geometry ? geometry.durationMin : null,
        distanceM: geometry ? geometry.distanceM : null,
        reachable: geometry !== null,
        source,
        geometry: geometry ? geometry.coordinates : undefined,
      });
    }
    resultsByCandidate.set(candidate.osmId, results);
  }

  // Steps 7, 9, 10 — exclude, rank, explain.
  const { ranked, excluded } = rankCandidates({
    candidates: considered,
    resultsByCandidate,
    origins: input.origins,
    preference: input.preference,
    maxTravelMinutes: input.maxTravelMinutes,
    topN: 5,
  });

  return {
    ranked,
    excluded,
    searchAreas,
    warnings,
    provider: deps.routingClient.kind === 'osrm' ? 'osrm' : 'demo',
    generatedAt: now.toISOString(),
    meetingTimeISO: input.meetingTimeISO,
    preference: input.preference,
    category: input.category,
    // Stale guard: stamp the decision version + participants signature
    // so callers can detect when the room changed after this search.
    decisionVersion: input.decisionVersion ?? null,
    participantsSignature: signatureFromOrigins(input.origins),
    stats: {
      discovered: discovered.length,
      duplicatesRemoved,
      invalidRemoved,
      considered: considered.length,
      routePairs: pairs.length,
      routeFailures,
    },
  };
}
