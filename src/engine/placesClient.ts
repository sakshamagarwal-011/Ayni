import { EngineError, EngineUnavailableError } from './errors';
import { buildOverpassQuery, deduplicatePlaces, parseOverpassResponse } from './places';
import type { CandidatePlace, MeetingCategory, SearchArea } from './types';

/**
 * Overpass API client (impure layer). Fair-use discipline, mirroring
 * the OSRM client's approach in src/map/routing.ts:
 *
 * - ONE POST per search area, sequential (the orchestrator never calls
 *   areas in parallel). Max 3 areas per run.
 * - In-memory cache keyed by the full query string (10-min TTL) +
 *   in-flight deduplication: identical concurrent searches share one
 *   request.
 * - Timeout via AbortController (default 25s, matching the QL timeout).
 * - At most ONE retry, only on 429/504, honouring Retry-After capped
 *   at 30s. No retry storms.
 * - Endpoint fallback: if an endpoint fails (network error, non-2xx
 *   including 406, timeout, invalid JSON), the next endpoint in
 *   resolveOverpassEndpoints() is tried, sequentially — never in
 *   parallel. The configured endpoint is always first; built-in
 *   mirrors are fallback only. The default public instance rejects
 *   requests from some networks (HTTP 406 from datacenter/cloud
 *   egress), so a single-endpoint client would fail outright there.
 *   The user's AbortSignal aborts the whole chain immediately.
 * - Failures become a typed EngineError ('places_unavailable') with a
 *   user-safe message — never an empty silent result, never a throw
 *   of an untyped string.
 *
 * Overpass fair use (overpass-api.de): the public instance is shared
 * infrastructure. Keep queries small (capped result counts, bounded
 * areas), do not poll, and self-host or use a mirror for anything
 * beyond light development use. See ENGINE.md.
 */

export interface PlacesSearchResult {
  places: CandidatePlace[];
  dropped: number;
  duplicatesRemoved: number;
  /** Endpoint URL that served this search (absent for the mock client). */
  endpoint?: string;
}

/**
 * Built-in Overpass mirrors, tried in order after the configured
 * endpoint. Public instances run by the OSM community; see
 * https://wiki.openstreetmap.org/wiki/Overpass_API for the full list.
 */
export const OVERPASS_MIRROR_URLS: readonly string[] = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * Endpoint order for one search: the configured URL first, then the
 * built-in mirrors, deduplicated (a configured URL that equals a
 * mirror is tried once). Trailing slashes are normalized so dedup
 * cannot be defeated by `.../interpreter/`.
 */
export function resolveOverpassEndpoints(configuredUrl: string): string[] {
  const endpoints: string[] = [];
  const seen = new Set<string>();
  for (const raw of [configuredUrl, ...OVERPASS_MIRROR_URLS]) {
    const url = raw.trim().replace(/\/+$/, '');
    if (url !== '' && !seen.has(url)) {
      seen.add(url);
      endpoints.push(url);
    }
  }
  return endpoints;
}

export interface PlacesClient {
  readonly provider: 'overpass' | 'mock';
  search(area: SearchArea, category: MeetingCategory, limit: number, signal?: AbortSignal): Promise<PlacesSearchResult>;
}

export interface OverpassFetchLike {
  (url: string, init?: { method?: string; body?: string; signal?: AbortSignal; headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    headers?: { get?: (name: string) => string | null };
    json: () => Promise<unknown>;
    text?: () => Promise<string>;
  }>;
}

export interface OverpassClientOptions {
  baseUrl: string;
  timeoutMs: number;
  cacheTtlMs?: number;
  maxRetryDelayMs?: number;
  fetchImpl?: OverpassFetchLike;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep that rejects promptly when `signal` aborts (no 30s stall on Retry-After waits). */
function sleepAbortable(ms: number, signal: AbortSignal | undefined, sleepFn: (ms: number) => Promise<void>): Promise<void> {
  if (!signal) return sleepFn(ms);
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void sleepFn(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Share an in-flight result with a second caller whose own signal can still cancel THEIR wait. */
function shareInflight<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function placesError(status: number): EngineUnavailableError {
  if (status === 429) {
    return new EngineUnavailableError(
      'places',
      'Place search is rate-limited right now — try again in a minute. No estimates shown.',
    );
  }
  return new EngineUnavailableError('places');
}

export function createOverpassClient(options: OverpassClientOptions): PlacesClient {
  const fetchImpl: OverpassFetchLike =
    options.fetchImpl ??
    ((url, init) => fetch(url, init) as unknown as ReturnType<OverpassFetchLike>);
  const now = options.now ?? (() => Date.now());
  const sleepFn = options.sleepFn ?? defaultSleep;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  const cache = new Map<string, { result: PlacesSearchResult; fetchedAt: number }>();
  const inflight = new Map<string, Promise<PlacesSearchResult>>();

  const endpoints = resolveOverpassEndpoints(options.baseUrl);

  /**
   * One endpoint, with the existing retry discipline: at most one
   * retry, only on 429/504, honouring Retry-After. Throws
   * EngineUnavailableError when this endpoint is exhausted (the caller
   * moves to the next endpoint) and rethrows AbortError when the
   * caller aborted (the caller must stop the whole chain).
   */
  async function fetchFromEndpoint(
    endpoint: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<PlacesSearchResult> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      const onExternalAbort = () => controller.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status === 504;
          if (retryable && attempt === 1) {
            const retryAfter = Number.parseInt(response.headers?.get?.('Retry-After') ?? '', 10);
            const delayMs = Number.isFinite(retryAfter)
              ? Math.min(maxRetryDelayMs, Math.max(0, retryAfter * 1000))
              : 1000;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onExternalAbort);
            await sleepAbortable(delayMs, signal, sleepFn);
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            continue;
          }
          throw placesError(response.status);
        }
        const payload = await response.json();
        const parsed = parseOverpassResponse(payload);
        const deduped = deduplicatePlaces(parsed.places);
        return {
          places: deduped.places,
          dropped: parsed.dropped,
          duplicatesRemoved: deduped.duplicatesRemoved,
          endpoint,
        };
      } catch (err) {
        if (err instanceof EngineError) throw err;
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (signal?.aborted) throw err;
          throw new EngineUnavailableError(
            'places',
            'Live place search timed out — try again later. No estimates shown.',
          );
        }
        throw new EngineUnavailableError('places');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  /**
   * Try the endpoints in order, sequentially. Any endpoint failure
   * (network error, non-2xx, timeout, invalid JSON) moves to the next
   * endpoint; only a caller abort stops the chain. When every endpoint
   * fails, the LAST endpoint's error is thrown, preserving the
   * existing EngineUnavailableError message/behaviour (no ranked
   * results, clear error).
   */
  async function runQuery(query: string, signal?: AbortSignal): Promise<PlacesSearchResult> {
    let lastError: EngineUnavailableError | null = null;
    for (const endpoint of endpoints) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        return await fetchFromEndpoint(endpoint, query, signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        if (err instanceof EngineUnavailableError) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new EngineUnavailableError('places');
  }

  return {
    provider: 'overpass',
    async search(area, category, limit, signal) {
      // The QL timeout derives from the client timeout so a configured
      // 60s client timeout is not silently capped by a 25s QL timeout.
      const query = buildOverpassQuery(area, category, limit, Math.round(options.timeoutMs / 1000));
      const entry = cache.get(query);
      if (entry && (cacheTtlMs <= 0 || now() - entry.fetchedAt <= cacheTtlMs)) {
        return entry.result;
      }
      const pending = inflight.get(query);
      if (pending) return shareInflight(pending, signal);
      const task = runQuery(query, signal)
        .then((result) => {
          if (cache.size >= MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(query, { result, fetchedAt: now() });
          return result;
        })
        .finally(() => {
          inflight.delete(query);
        });
      inflight.set(query, task);
      return task;
    },
  };
}

/**
 * Shared Overpass client singleton (keyed by endpoint + timeout), so
 * the 10-minute cache survives across searches instead of being thrown
 * away with a fresh client per search. Mirrors the routing singleton
 * in src/map/routing.ts. Tests should use createOverpassClient directly.
 */
const sharedClients = new Map<string, PlacesClient>();

export function getSharedOverpassClient(options: OverpassClientOptions): PlacesClient {
  const key = `${options.baseUrl}|${options.timeoutMs}`;
  const existing = sharedClients.get(key);
  if (existing) return existing;
  const client = createOverpassClient(options);
  sharedClients.set(key, client);
  return client;
}

/** Lenient demo-category matching: room spot labels vs. the search category. */
const DEMO_CATEGORY_TOKENS: Record<MeetingCategory, string[]> = {
  cafe: ['café', 'cafe', 'coffee'],
  restaurant: ['restaurant'],
  bar: ['bar', 'pub', 'brewery'],
  park: ['park', 'garden'],
  library: ['library'],
  coworking: ['coworking', 'co-working'],
  fastFood: ['fast food'],
  mall: ['mall'],
  metroStation: ['metro'],
  railwayStation: ['railway', 'station'],
  marketplace: ['market'],
  teaStall: ['tea'],
  any: [],
};

/**
 * Mock places client: returns injected demo places (the room's existing
 * spots, mapped to CandidatePlace) for every search, filtered by the
 * requested category (so the category selector is honoured in demo
 * mode too). Used by the demo path only; results are always labelled Demo.
 */
export function createMockPlacesClient(demoPlaces: CandidatePlace[]): PlacesClient {
  return {
    provider: 'mock',
    async search(_area, category) {
      if (category === 'any') return { places: [...demoPlaces], dropped: 0, duplicatesRemoved: 0 };
      const tokens = DEMO_CATEGORY_TOKENS[category] ?? [];
      const places = demoPlaces.filter((p) => {
        const label = p.category.toLowerCase();
        return tokens.some((t) => label.includes(t));
      });
      return { places, dropped: 0, duplicatesRemoved: 0 };
    },
  };
}
