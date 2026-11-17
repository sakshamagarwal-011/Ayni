import { describe, expect, it } from 'vitest';
import {
  buildOsrmUrl,
  createOsrmClient,
  describeRouteSource,
  fallbackGeometry,
  parseOsrmRoute,
  profileForMode,
  routeCacheKey,
  type FetchLike,
} from '../../src/map/routing';

const FROM = { lat: 12.9716, lng: 77.6412 };
const TO = { lat: 12.9352, lng: 77.6245 };

const OSRM_OK = {
  code: 'Ok',
  routes: [
    {
      distance: 5234.5,
      duration: 3661,
      geometry: {
        type: 'LineString',
        coordinates: [
          [77.6412, 12.9716],
          [77.63, 12.95],
          [77.6245, 12.9352],
        ],
      },
    },
  ],
};

function stubFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const urls: string[] = [];
  let calls = 0;
  const fetchFn: FetchLike = async (url) => {
    calls += 1;
    urls.push(url);
    return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => payload };
  };
  return { fetchFn, urls, calls: () => calls };
}

describe('profileForMode', () => {
  it('maps car/walk/bike to OSRM profiles', () => {
    expect(profileForMode('car')).toEqual({ profile: 'driving', transitApproximation: false });
    expect(profileForMode('walk')).toEqual({ profile: 'foot', transitApproximation: false });
    expect(profileForMode('bike')).toEqual({ profile: 'bike', transitApproximation: false });
  });

  it('maps transit to driving and flags the approximation', () => {
    expect(profileForMode('transit')).toEqual({ profile: 'driving', transitApproximation: true });
  });
});

describe('routeCacheKey + buildOsrmUrl', () => {
  it('rounds coords to 5 decimals and includes the profile', () => {
    const a = routeCacheKey({ lat: 12.9715999, lng: 77.6412001 }, TO, 'driving');
    const b = routeCacheKey(FROM, TO, 'driving');
    expect(a).toBe(b);
    expect(routeCacheKey(FROM, TO, 'foot')).not.toBe(b);
    expect(routeCacheKey(TO, FROM, 'driving')).not.toBe(b);
  });

  it('builds a GeoJSON route URL with lng,lat ordering', () => {
    const url = buildOsrmUrl('https://router.project-osrm.org/', 'driving', FROM, TO);
    expect(url).toBe(
      'https://router.project-osrm.org/route/v1/driving/77.64120,12.97160;77.62450,12.93520?overview=full&geometries=geojson&steps=false',
    );
  });
});

describe('parseOsrmRoute', () => {
  it('parses a valid OSRM response (seconds -> minutes, metres rounded)', () => {
    const parsed = parseOsrmRoute(OSRM_OK, 'driving', false);
    expect(parsed).not.toBeNull();
    expect(parsed!.distanceM).toBe(5235);
    expect(parsed!.durationMin).toBe(61);
    expect(parsed!.source).toBe('osrm');
    expect(parsed!.profile).toBe('driving');
    expect(parsed!.coordinates).toHaveLength(3);
  });

  it('preserves the transit approximation flag', () => {
    expect(parseOsrmRoute(OSRM_OK, 'driving', true)?.transitApproximation).toBe(true);
  });

  it('returns null for non-Ok, empty, or malformed payloads', () => {
    expect(parseOsrmRoute({ code: 'NoRoute', routes: [] }, 'driving', false)).toBeNull();
    expect(parseOsrmRoute({ code: 'Ok', routes: [] }, 'driving', false)).toBeNull();
    expect(parseOsrmRoute(null, 'driving', false)).toBeNull();
    expect(parseOsrmRoute('nope', 'driving', false)).toBeNull();
    expect(
      parseOsrmRoute({ code: 'Ok', routes: [{ distance: 100, duration: 60, geometry: { type: 'LineString', coordinates: [[77, 12]] } }] }, 'driving', false),
    ).toBeNull();
    expect(
      parseOsrmRoute({ code: 'Ok', routes: [{ distance: -5, duration: 60, geometry: OSRM_OK.routes[0].geometry }] }, 'driving', false),
    ).toBeNull();
    expect(
      parseOsrmRoute({ code: 'Ok', routes: [{ distance: 100, duration: 'fast', geometry: OSRM_OK.routes[0].geometry }] }, 'driving', false),
    ).toBeNull();
    expect(
      parseOsrmRoute(
        { code: 'Ok', routes: [{ distance: 100, duration: 60, geometry: { type: 'LineString', coordinates: [[77, 12], ['x', 12]] } }] },
        'driving',
        false,
      ),
    ).toBeNull();
  });
});

describe('fallbackGeometry + describeRouteSource', () => {
  it('falls back to a straight line with a positive estimate', () => {
    const fallback = fallbackGeometry(FROM, TO, 'car');
    expect(fallback.source).toBe('estimated');
    expect(fallback.coordinates).toEqual([
      [77.6412, 12.9716],
      [77.6245, 12.9352],
    ]);
    expect(fallback.distanceM).toBeGreaterThan(0);
    expect(fallback.durationMin).toBeGreaterThan(0);
  });

  it('labels sources honestly', () => {
    expect(describeRouteSource('osrm')).toBe('OSRM route (development)');
    expect(describeRouteSource('osrm', true)).toContain('no transit routing');
    expect(describeRouteSource('estimated')).toBe('Estimated — OSRM unavailable');
    expect(describeRouteSource('mock')).toBe('Demo estimate — straight-line');
  });
});

describe('OSRM client (mocked fetch — no real network)', () => {
  const baseOptions = {
    baseUrl: 'https://router.project-osrm.org',
    minIntervalMs: 0,
    timeoutMs: 5000,
    cacheTtlMs: 600_000,
  };

  it('fetches and parses an OSRM route', async () => {
    const { fetchFn, urls } = stubFetch(OSRM_OK);
    const client = createOsrmClient({ ...baseOptions, fetchFn });
    const route = await client.fetchRoute(FROM, TO, 'car');
    expect(route.source).toBe('osrm');
    expect(route.distanceM).toBe(5235);
    expect(urls[0]).toContain('/route/v1/driving/');
    expect(urls[0]).toContain('geometries=geojson');
  });

  it('uses the foot profile for walking and driving for transit', async () => {
    const { fetchFn, urls } = stubFetch(OSRM_OK);
    const client = createOsrmClient({ ...baseOptions, fetchFn });
    await client.fetchRoute(FROM, TO, 'walk');
    const transit = await client.fetchRoute(FROM, TO, 'transit');
    expect(urls[0]).toContain('/route/v1/foot/');
    expect(urls[1]).toContain('/route/v1/driving/');
    expect(transit.transitApproximation).toBe(true);
  });

  it('caches identical requests (no second fetch)', async () => {
    const { fetchFn, calls } = stubFetch(OSRM_OK);
    const client = createOsrmClient({ ...baseOptions, fetchFn });
    await client.fetchRoute(FROM, TO, 'car');
    await client.fetchRoute({ lat: 12.9715999, lng: 77.6412001 }, TO, 'car');
    expect(calls()).toBe(1);
    expect(client.cacheSize()).toBe(1);
  });

  it('refetches after the cache TTL expires', async () => {
    let now = 1_000_000;
    const { fetchFn, calls } = stubFetch(OSRM_OK);
    const client = createOsrmClient({ ...baseOptions, cacheTtlMs: 1000, fetchFn, now: () => now });
    await client.fetchRoute(FROM, TO, 'car');
    now += 1001;
    await client.fetchRoute(FROM, TO, 'car');
    expect(calls()).toBe(2);
  });

  it('clearCache forces a refetch', async () => {
    const { fetchFn, calls } = stubFetch(OSRM_OK);
    const client = createOsrmClient({ ...baseOptions, fetchFn });
    await client.fetchRoute(FROM, TO, 'car');
    client.clearCache();
    await client.fetchRoute(FROM, TO, 'car');
    expect(calls()).toBe(2);
  });

  it('falls back on 429 without throwing', async () => {
    const { fetchFn } = stubFetch({}, { ok: false, status: 429 });
    const client = createOsrmClient({ ...baseOptions, fetchFn });
    const route = await client.fetchRoute(FROM, TO, 'car');
    expect(route.source).toBe('estimated');
    expect(route.coordinates).toHaveLength(2);
  });

  it('falls back on network errors and malformed payloads', async () => {
    const throwing: FetchLike = async () => {
      throw new Error('network down');
    };
    const client1 = createOsrmClient({ ...baseOptions, fetchFn: throwing });
    expect((await client1.fetchRoute(FROM, TO, 'car')).source).toBe('estimated');

    const { fetchFn } = stubFetch({ code: 'NoRoute', routes: [] });
    const client2 = createOsrmClient({ ...baseOptions, fetchFn });
    expect((await client2.fetchRoute(FROM, TO, 'car')).source).toBe('estimated');
  });

  it('does not cache fallbacks (a recovered server is retried)', async () => {
    let fail = true;
    const fetchFn: FetchLike = async () => {
      if (fail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => OSRM_OK };
    };
    const client = createOsrmClient({ ...baseOptions, fetchFn });
    expect((await client.fetchRoute(FROM, TO, 'car')).source).toBe('estimated');
    fail = false;
    expect((await client.fetchRoute(FROM, TO, 'car')).source).toBe('osrm');
  });

  it('fetchRoutes preserves order and falls back per-request', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      if (calls === 2) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => OSRM_OK };
    };
    const client = createOsrmClient({ ...baseOptions, fetchFn });
    const routes = await client.fetchRoutes([
      { from: FROM, to: TO, mode: 'car' },
      { from: TO, to: FROM, mode: 'car' },
    ]);
    expect(routes).toHaveLength(2);
    expect(routes[0].source).toBe('osrm');
    expect(routes[1].source).toBe('estimated');
  });

  it('spaces sequential requests by at least the minimum interval', async () => {
    const { fetchFn } = stubFetch(OSRM_OK);
    const client = createOsrmClient({ ...baseOptions, minIntervalMs: 60, fetchFn });
    const start = Date.now();
    await client.fetchRoutes([
      { from: FROM, to: TO, mode: 'car' },
      { from: TO, to: FROM, mode: 'car' },
    ]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    const { fetchFn, calls } = stubFetch(OSRM_OK);
    const client = createOsrmClient({ ...baseOptions, minIntervalMs: 50, fetchFn });
    const controller = new AbortController();
    controller.abort();
    await expect(client.fetchRoute(FROM, TO, 'car', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls()).toBe(0);
  });

  it('keeps the queue alive after an abort', async () => {
    const { fetchFn } = stubFetch(OSRM_OK);
    const client = createOsrmClient({ ...baseOptions, minIntervalMs: 20, fetchFn });
    const controller = new AbortController();
    controller.abort();
    await expect(client.fetchRoute(FROM, TO, 'car', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const route = await client.fetchRoute(FROM, TO, 'car');
    expect(route.source).toBe('osrm');
  });
});
