import { EngineUnavailableError } from './errors';
import { filterPlacesToCircle } from './places';
import { shareInflight } from './placesClient';
import type { PlacesClient, PlacesSearchResult } from './placesClient';
import type { CandidatePlace, MeetingCategory } from './types';

/**
 * Supabase Edge Function proxy client for place search (impure layer).
 *
 * WHY: browsers on cloud/datacenter networks cannot query Overpass
 * directly — the main public instance rejects them with HTTP 406 and
 * the small mirrors time out server-side even on light queries (live
 * testing, 2026-11-17). The browser talks only to Supabase (reachable
 * from every network), and the `places-search` Edge Function queries
 * Overpass server-side. See ENGINE.md ("Places proxy") for the
 * request/response contract and the server-side fallback order.
 *
 * The client sends STRUCTURED parameters only — never raw Overpass
 * QL (the function builds the query itself). Places carry source
 * 'overpass': the data is live OpenStreetMap data, fetched
 * server-side; only the transport differs from the direct client.
 *
 * Discipline mirrors the direct Overpass client:
 * - ONE invocation per search area, sequential (the orchestrator
 *   never calls areas in parallel). Max 3 areas per run.
 * - In-memory cache keyed by the structured params (10-min TTL) +
 *   in-flight deduplication: identical concurrent searches share one
 *   invocation.
 * - 55s client timeout: covers the function's worst case (3
 *   endpoints x 20s, plus one capped Retry-After wait, is bounded
 *   by the function's own per-endpoint discipline; the client
 *   timeout only guards a hung invocation). Timeout surfaces the
 *   same timeout user message as the direct client.
 * - Abort-aware: the caller's signal ends THEIR wait promptly.
 *   supabase-js `functions.invoke` takes no AbortSignal, so an abort
 *   cannot cancel the underlying HTTP request — it only stops
 *   waiting, and a late result is discarded (never cached for an
 *   aborted caller; a shared in-flight result still caches for
 *   other waiters). Cancel in the UI therefore stays responsive.
 * - Failures become a typed EngineError ('places_unavailable') with
 *   a user-safe message — never an empty silent result.
 * - The circle filter is re-applied client-side (defense in depth):
 *   the function already trims bbox corners to the circle, so this
 *   normally trims zero places; any it does trim is counted honestly.
 */

export const PROXY_PLACES_FUNCTION = 'places-search';

/** Structured search parameters sent to the proxy. No raw QL ever leaves the browser. */
export interface ProxyPlacesRequestBody {
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  category: MeetingCategory;
  limit: number;
}

/**
 * Minimal shape of `supabase.functions.invoke`, injected for
 * testability. The panel wires the real one via the shared
 * getSupabaseClient() singleton (see OptimizationPanel).
 */
export type ProxyPlacesInvokeFn = (
  functionName: string,
  options: { body: ProxyPlacesRequestBody },
) => Promise<{ data: unknown; error: unknown }>;

export interface ProxyPlacesClientOptions {
  invokeFn: ProxyPlacesInvokeFn;
  /** Client-side invocation timeout (ms). Default 55s. */
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

const DEFAULT_PROXY_TIMEOUT_MS = 55_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;

const TIMEOUT_MESSAGE = 'Live place search timed out — try again later. No estimates shown.';

/** Wire shape of one place returned by the proxy (see ENGINE.md). */
interface ProxyPlacePayload {
  osmId?: unknown;
  name?: unknown;
  category?: unknown;
  lat?: unknown;
  lng?: unknown;
  address?: unknown;
}

interface ProxyResponsePayload {
  places?: unknown;
  dropped?: unknown;
  duplicatesRemoved?: unknown;
  outsideCircle?: unknown;
  endpoint?: unknown;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function asEndpoint(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Map one wire place to a CandidatePlace. Returns null for entries
 * that cannot be presented (missing id/name, non-finite or
 * out-of-range coordinates) — the caller counts them as dropped.
 * A missing/blank category label falls back to 'Place', matching the
 * direct parser's fallback (categoryLabelForTags).
 */
function toCandidatePlace(raw: unknown): CandidatePlace | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const place = raw as ProxyPlacePayload;
  if (typeof place.osmId !== 'string' || place.osmId.length === 0) return null;
  if (typeof place.name !== 'string' || place.name.trim().length === 0) return null;
  if (
    typeof place.lat !== 'number' ||
    typeof place.lng !== 'number' ||
    !Number.isFinite(place.lat) ||
    !Number.isFinite(place.lng) ||
    place.lat < -90 ||
    place.lat > 90 ||
    place.lng < -180 ||
    place.lng > 180
  ) {
    return null;
  }
  return {
    osmId: place.osmId,
    name: place.name.trim(),
    category: typeof place.category === 'string' && place.category.trim().length > 0 ? place.category : 'Place',
    lat: place.lat,
    lng: place.lng,
    address: typeof place.address === 'string' && place.address.length > 0 ? place.address : undefined,
    source: 'overpass',
  };
}

export function createProxyPlacesClient(options: ProxyPlacesClientOptions): PlacesClient {
  const invokeFn = options.invokeFn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, { result: PlacesSearchResult; fetchedAt: number }>();
  const inflight = new Map<string, Promise<PlacesSearchResult>>();

  function cacheKey(body: ProxyPlacesRequestBody): string {
    return JSON.stringify(body);
  }

  /** One invocation + mapping, bounded by the client timeout. No signal: callers race via shareInflight. */
  async function runSearch(body: ProxyPlacesRequestBody): Promise<PlacesSearchResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const invocation = invokeFn(PROXY_PLACES_FUNCTION, { body });
      const timed = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new EngineUnavailableError('places', TIMEOUT_MESSAGE)), timeoutMs);
      });
      const { data, error } = await Promise.race([invocation, timed]);
      if (error) throw new EngineUnavailableError('places');
      if (typeof data !== 'object' || data === null) throw new EngineUnavailableError('places');
      const payload = data as ProxyResponsePayload;
      if (!Array.isArray(payload.places)) throw new EngineUnavailableError('places');
      const places: CandidatePlace[] = [];
      let invalidEntries = 0;
      for (const raw of payload.places) {
        const mapped = toCandidatePlace(raw);
        if (mapped) places.push(mapped);
        else invalidEntries += 1;
      }
      return {
        places,
        dropped: asCount(payload.dropped) + invalidEntries,
        duplicatesRemoved: asCount(payload.duplicatesRemoved),
        outsideCircle: asCount(payload.outsideCircle),
        endpoint: asEndpoint(payload.endpoint),
      };
    } catch (err) {
      if (err instanceof EngineUnavailableError) throw err;
      throw new EngineUnavailableError('places');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  return {
    provider: 'proxy',
    async search(area, category, limit, signal) {
      const body: ProxyPlacesRequestBody = {
        centerLat: area.centerLat,
        centerLng: area.centerLng,
        radiusKm: area.radiusKm,
        category,
        limit,
      };
      const key = cacheKey(body);
      const entry = cache.get(key);
      if (entry && (cacheTtlMs <= 0 || now() - entry.fetchedAt <= cacheTtlMs)) {
        return entry.result;
      }
      const pending = inflight.get(key);
      if (pending) return shareInflight(pending, signal);
      const task = runSearch(body)
        .then((result) => {
          // Defense in depth: the function already trims bbox corners
          // to the circle; re-apply here so ranking never sees a
          // place outside the circle even if the proxy changes.
          const circled = filterPlacesToCircle(result.places, area);
          const filtered: PlacesSearchResult = {
            ...result,
            places: circled.places,
            dropped: result.dropped + circled.outsideCircle,
            outsideCircle: (result.outsideCircle ?? 0) + circled.outsideCircle,
          };
          if (cache.size >= MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(key, { result: filtered, fetchedAt: now() });
          return filtered;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, task);
      return shareInflight(task, signal);
    },
  };
}

/**
 * Shared proxy client singleton, so the 10-minute cache survives
 * across searches instead of being thrown away with a fresh client
 * per search. Mirrors getSharedOverpassClient. There is exactly one
 * proxy function, so the first caller's invokeFn/options win;
 * later callers reuse the same instance (the panel always passes
 * the shared Supabase client's invoke). Tests should use
 * createProxyPlacesClient directly.
 */
let sharedProxyClient: PlacesClient | null = null;

export function getSharedProxyPlacesClient(options: ProxyPlacesClientOptions): PlacesClient {
  if (sharedProxyClient) return sharedProxyClient;
  sharedProxyClient = createProxyPlacesClient(options);
  return sharedProxyClient;
}
