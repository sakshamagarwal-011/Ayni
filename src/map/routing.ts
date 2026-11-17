import { estimateDurationMin, haversineDistanceM } from '../lib/distance';
import type { Coordinates, RouteSource, TravelMode } from '../types';
import { getMapConfig } from './config';
import { straightLineGeometry } from './geo';

/**
 * OSRM routing client + deterministic fallback.
 *
 * RESPECTING THE PUBLIC DEMO SERVER (router.project-osrm.org):
 * - Serial queue: max 1 request in flight, minimum 1100ms between
 *   request starts (demo-server policy: do not exceed 1 req/s).
 * - In-memory cache (rounded coords + profile, 10-min TTL) so mode
 *   switches and re-renders do not re-request the same route.
 * - 10s timeout, AbortController cancellation, single attempt only —
 *   no retries, no retry storms.
 * - On ANY failure (429, 5xx, network error, timeout, bad payload) the
 *   caller gets a deterministic haversine fallback labelled
 *   'estimated' — the UI never blocks on routing. The optimization
 *   engine uses the strict variants (fetchRouteStrict /
 *   fetchRoutesStrict) instead: failures resolve to null, never to a
 *   fallback, so live rankings are never built on estimates.
 * - Callers fetch ONLY the visible screen's routes (selected spot +
 *   selected mode), never all participant × spot × mode combos.
 * - The client is never used when the routing provider is 'mock'/'off'
 *   (see useMapRoutes) — the default provider is 'mock', so zero OSRM
 *   requests happen until the operator opts in with
 *   VITE_ROUTING_PROVIDER=osrm. Point VITE_OSRM_BASE_URL at a
 *   self-hosted OSRM instance (or another OSRM-compatible endpoint) for
 *   anything beyond light development use. See MAPS.md.
 */

export type OsrmProfile = 'driving' | 'foot' | 'bike';

export interface RouteGeometry {
  /** [lng, lat] pairs in GeoJSON order. */
  coordinates: number[][];
  distanceM: number;
  durationMin: number;
  source: RouteSource;
  /** OSRM profile used ('driving' | 'foot' | 'bike'), or 'estimate' for fallbacks. */
  profile: string;
  /** True when the driving profile stood in for transit (OSRM has no transit). */
  transitApproximation: boolean;
}

export interface ProfileMapping {
  profile: OsrmProfile;
  transitApproximation: boolean;
}

/** Map app travel modes to OSRM demo-server profiles. Transit has no OSRM profile. */
export function profileForMode(mode: TravelMode): ProfileMapping {
  switch (mode) {
    case 'walk':
      return { profile: 'foot', transitApproximation: false };
    case 'bike':
      return { profile: 'bike', transitApproximation: false };
    case 'transit':
      return { profile: 'driving', transitApproximation: true };
    case 'car':
    default:
      return { profile: 'driving', transitApproximation: false };
  }
}

/** Cache key: coords rounded to 5 decimals (~1m) + profile. */
export function routeCacheKey(from: Coordinates, to: Coordinates, profile: string): string {
  const fmt = (n: number) => n.toFixed(5);
  return `${profile}:${fmt(from.lat)},${fmt(from.lng)}->${fmt(to.lat)},${fmt(to.lng)}`;
}

/** OSRM route URL: GeoJSON geometry, full overview, no steps (we draw the line only). */
export function buildOsrmUrl(baseUrl: string, profile: string, from: Coordinates, to: Coordinates): string {
  const base = baseUrl.replace(/\/+$/, '');
  const fmt = (n: number) => n.toFixed(5);
  return (
    `${base}/route/v1/${profile}/${fmt(from.lng)},${fmt(from.lat)};${fmt(to.lng)},${fmt(to.lat)}` +
    `?overview=full&geometries=geojson&steps=false`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse an OSRM /route response into a RouteGeometry. Returns null for
 * any malformed payload (non-Ok code, missing route, bad geometry) so
 * the caller can fall back cleanly. Pure — no network access.
 */
export function parseOsrmRoute(
  payload: unknown,
  profile: string,
  transitApproximation: boolean,
): RouteGeometry | null {
  if (!isRecord(payload) || payload.code !== 'Ok') return null;
  const routes = payload.routes;
  if (!Array.isArray(routes) || routes.length === 0) return null;
  const route = routes[0];
  if (!isRecord(route)) return null;
  const geometry = route.geometry;
  if (!isRecord(geometry) || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return null;
  const coordinates = geometry.coordinates as unknown[];
  if (coordinates.length < 2) return null;
  for (const pair of coordinates) {
    if (!Array.isArray(pair) || pair.length < 2 || !pair.slice(0, 2).every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return null;
    }
  }
  const distance = route.distance;
  const duration = route.duration;
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) return null;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
  return {
    coordinates: coordinates as number[][],
    distanceM: Math.round(distance),
    durationMin: Math.max(1, Math.round(duration / 60)),
    source: 'osrm',
    profile,
    transitApproximation,
  };
}

/** Deterministic fallback: straight-line geometry + haversine estimate (same formula as distance.ts). */
export function fallbackGeometry(from: Coordinates, to: Coordinates, mode: TravelMode): RouteGeometry {
  const straightM = haversineDistanceM(from, to);
  return {
    coordinates: straightLineGeometry(from, to),
    distanceM: Math.round(straightM * 1.3),
    durationMin: estimateDurationMin(straightM, mode),
    source: 'estimated',
    profile: 'estimate',
    transitApproximation: false,
  };
}

/** User-facing label for a route source. Never present estimates as live routes. */
export function describeRouteSource(source: RouteSource, transitApproximation = false): string {
  switch (source) {
    case 'osrm':
      return transitApproximation
        ? 'OSRM route (development) · driving profile — no transit routing'
        : 'OSRM route (development)';
    case 'estimated':
      return 'Estimated — OSRM unavailable';
    case 'mock':
      return 'Demo estimate — straight-line';
  }
}

/** Minimal fetch shape so tests can inject a stub without a full Response. */
export interface FetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
}

export interface OsrmClientOptions {
  baseUrl: string;
  minIntervalMs: number;
  timeoutMs: number;
  cacheTtlMs: number;
  fetchFn?: FetchLike;
  now?: () => number;
}

const MAX_CACHE_ENTRIES = 200;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export interface OsrmClient {
  /** One route. Always resolves (fallback on failure) unless `signal` aborts. */
  fetchRoute(from: Coordinates, to: Coordinates, mode: TravelMode, signal?: AbortSignal): Promise<RouteGeometry>;
  /** Sequential routes (queue order). Each entry falls back independently. */
  fetchRoutes(
    requests: Array<{ from: Coordinates; to: Coordinates; mode: TravelMode }>,
    signal?: AbortSignal,
  ): Promise<RouteGeometry[]>;
  /**
   * Strict route for the optimization engine: resolves to null on ANY
   * failure (429/5xx/network/timeout/bad payload) instead of falling
   * back to a straight-line estimate. Shares the same queue/cache/
   * timeout as fetchRoute. External aborts still reject.
   */
  fetchRouteStrict(from: Coordinates, to: Coordinates, mode: TravelMode, signal?: AbortSignal): Promise<RouteGeometry | null>;
  /** Sequential strict routes (queue order). Each entry is null on failure. */
  fetchRoutesStrict(
    requests: Array<{ from: Coordinates; to: Coordinates; mode: TravelMode }>,
    signal?: AbortSignal,
  ): Promise<Array<RouteGeometry | null>>;
  clearCache(): void;
  cacheSize(): number;
}

export function createOsrmClient(options: OsrmClientOptions): OsrmClient {
  const fetchFn: FetchLike =
    options.fetchFn ??
    ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { geometry: RouteGeometry; fetchedAt: number }>();
  let lastRequestStart = 0;
  // Serial queue: every request chains onto the previous one.
  let queue: Promise<unknown> = Promise.resolve();

  function cached(key: string): RouteGeometry | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (options.cacheTtlMs > 0 && now() - entry.fetchedAt > options.cacheTtlMs) {
      cache.delete(key);
      return null;
    }
    return entry.geometry;
  }

  function store(key: string, geometry: RouteGeometry): void {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { geometry, fetchedAt: now() });
  }

  async function runOne(
    from: Coordinates,
    to: Coordinates,
    mode: TravelMode,
    signal: AbortSignal | undefined,
    allowFallback: boolean,
  ): Promise<RouteGeometry | null> {
    const { profile, transitApproximation } = profileForMode(mode);
    const key = routeCacheKey(from, to, profile);
    const hit = cached(key);
    if (hit) return hit;

    // Enforce the minimum gap between request starts.
    const waitMs = Math.max(0, lastRequestStart + options.minIntervalMs - now());
    await sleep(waitMs, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    lastRequestStart = now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const response = await fetchFn(buildOsrmUrl(options.baseUrl, profile, from, to), {
        signal: controller.signal,
      });
      if (!response.ok) return allowFallback ? fallbackGeometry(from, to, mode) : null;
      const payload = await response.json();
      const parsed = parseOsrmRoute(payload, profile, transitApproximation);
      if (!parsed) return allowFallback ? fallbackGeometry(from, to, mode) : null;
      const geometry = parsed;
      // Cache OSRM successes only; fallbacks are cheap to recompute and
      // must not mask a recovered server for the full TTL.
      store(key, geometry);
      return geometry;
    } catch (err) {
      if (signal?.aborted || controller.signal.aborted) {
        // External cancellation propagates; timeouts fall back (or null in strict mode).
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      }
      void err;
      return allowFallback ? fallbackGeometry(from, to, mode) : null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  const fetchRoute: OsrmClient['fetchRoute'] = async (from, to, mode, signal) => {
    const task = queue.then(() => runOne(from, to, mode, signal, true));
    // Keep the chain alive after rejections (e.g. aborts) so later
    // requests are not poisoned.
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    const result = await task;
    // runOne with allowFallback=true never resolves null; the fallback
    // below is unreachable but keeps the type honest.
    return result ?? fallbackGeometry(from, to, mode);
  };

  const fetchRouteStrict: OsrmClient['fetchRouteStrict'] = (from, to, mode, signal) => {
    const task = queue.then(() => runOne(from, to, mode, signal, false));
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  return {
    fetchRoute,
    fetchRouteStrict,
    async fetchRoutes(requests, signal) {
      const out: RouteGeometry[] = [];
      for (const req of requests) {
        out.push(await fetchRoute(req.from, req.to, req.mode, signal));
      }
      return out;
    },
    async fetchRoutesStrict(requests, signal) {
      const out: Array<RouteGeometry | null> = [];
      for (const req of requests) {
        out.push(await fetchRouteStrict(req.from, req.to, req.mode, signal));
      }
      return out;
    },
    clearCache() {
      cache.clear();
    },
    cacheSize() {
      return cache.size;
    },
  };
}

let defaultClient: OsrmClient | null = null;

/** Lazily-created client from the runtime map config. */
export function getDefaultRoutingClient(): OsrmClient {
  if (defaultClient) return defaultClient;
  const config = getMapConfig();
  defaultClient = createOsrmClient({
    baseUrl: config.osrmBaseUrl,
    minIntervalMs: config.osrmMinIntervalMs,
    timeoutMs: config.osrmTimeoutMs,
    cacheTtlMs: config.osrmCacheTtlMs,
  });
  return defaultClient;
}
