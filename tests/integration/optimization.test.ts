import { describe, expect, it } from 'vitest';
import { createOsrmClient, type FetchLike } from '../../src/map/routing';
import {
  EngineNoPlacesError,
  EngineQuotaError,
  EngineUnavailableError,
  OptimizationValidationError,
  createDemoEngineRoutingAdapter,
  createMockPlacesClient,
  createOsrmEngineRoutingAdapter,
  createOverpassClient,
  runOptimization,
  type OptimizationInput,
  type OverpassFetchLike,
  type ParticipantOrigin,
} from '../../src/engine';
import overpassFixture from '../fixtures/overpass-cafes.json';
import osrmFixture from '../fixtures/osrm-route.json';

/**
 * Integration tests with MOCKED API responses (no network).
 * Overpass + OSRM payloads come from tests/fixtures (hand-written mock
 * data). The OSRM stub varies duration by destination longitude so
 * ranking assertions are deterministic.
 */

const NOW = new Date('2026-11-17T12:00:00.000Z');

function origin(overrides: Partial<ParticipantOrigin> = {}): ParticipantOrigin {
  return {
    participantId: 'p1',
    displayName: 'Aarav',
    lat: 12.9716,
    lng: 77.6412,
    mode: 'car',
    required: true,
    locationUpdatedAt: '2026-11-17T11:30:00.000Z',
    locationExpiresAt: '2026-11-17T14:00:00.000Z',
    consentGiven: true,
    ...overrides,
  };
}

function input(overrides: Partial<OptimizationInput> = {}): OptimizationInput {
  return {
    roomId: 'room-1',
    roomStatus: 'lobby',
    currentParticipantId: 'p1',
    memberParticipantIds: ['p1', 'p2'],
    requiredParticipantIds: ['p1', 'p2'],
    origins: [
      origin(),
      origin({ participantId: 'p2', displayName: 'Priya', lat: 12.9352, lng: 77.6245, mode: 'walk' }),
    ],
    category: 'cafe',
    meetingTimeISO: '2026-11-17T14:00:00.000Z',
    preference: 'balanced',
    ...overrides,
  };
}

interface OsrmStubOptions {
  failAll?: boolean;
  /** Destination longitude that returns NoRoute. */
  noRouteLng?: number;
}

/** OSRM stub: duration 15/25/35 min by destination lng (77.64/77.65/77.66). */
function osrmStub(opts: OsrmStubOptions = {}) {
  let calls = 0;
  const urls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls += 1;
    urls.push(url);
    if (opts.failAll) return { ok: false, status: 500, json: async () => ({}) };
    const match = /\/route\/v1\/(\w+)\/([\d.]+),([\d.]+);([\d.]+),([\d.]+)/.exec(url);
    const toLng = match ? Number(match[4]) : 77.64;
    if (opts.noRouteLng !== undefined && Math.abs(toLng - opts.noRouteLng) < 0.001) {
      return { ok: true, status: 200, json: async () => ({ code: 'NoRoute', routes: [] }) };
    }
    const index = Math.round((toLng - 77.64) * 100);
    const durationMin = 15 + index * 10;
    const payload = {
      ...osrmFixture,
      routes: [
        {
          distance: 5000 + index * 2000,
          duration: durationMin * 60,
          geometry: {
            type: 'LineString',
            coordinates: [
              [77.6412, 12.9716],
              [toLng, 12.95],
            ],
          },
        },
      ],
    };
    return { ok: true, status: 200, json: async () => payload };
  };
  return { fetchFn, calls: () => calls, urls };
}

interface OverpassStubOptions {
  /** Number of leading 429 responses before success (Infinity = always 429). */
  fail429Count?: number;
  payload?: unknown;
}

/**
 * Places inside the 2 km floor circle around (12.9716, 77.6412), for
 * the co-located-origin tests. The shared fixture's places sit ~2.4 km
 * from that centre, and the Overpass client now honestly trims
 * bbox-corner places outside the search circle — so those tests need
 * a payload a real bbox response for their area would contain.
 */
const NEARBY_PAYLOAD = {
  elements: [
    { id: 11, lat: 12.9716, lon: 77.64, type: 'node', tags: { name: 'Near A', amenity: 'cafe' } },
    { id: 12, lat: 12.9716, lon: 77.645, type: 'node', tags: { name: 'Near B', amenity: 'cafe' } },
    { id: 13, lat: 12.9716, lon: 77.65, type: 'node', tags: { name: 'Near C', amenity: 'cafe' } },
  ],
};

function overpassStub(opts: OverpassStubOptions = {}) {
  let calls = 0;
  const fetchImpl: OverpassFetchLike = async () => {
    calls += 1;
    if (opts.fail429Count !== undefined && calls <= opts.fail429Count) {
      return {
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '0' : null) },
        json: async () => ({}),
      };
    }
    return { ok: true, status: 200, json: async () => opts.payload ?? overpassFixture };
  };
  return { fetchImpl, calls: () => calls };
}

function liveDeps(osrm: ReturnType<typeof osrmStub>, overpass: ReturnType<typeof overpassStub>, extra: { maxOsrmRequests?: number } = {}) {
  const osrmClient = createOsrmClient({
    baseUrl: 'https://router.example.org',
    minIntervalMs: 0,
    timeoutMs: 5000,
    cacheTtlMs: 600_000,
    fetchFn: osrm.fetchFn,
  });
  return {
    placesClient: createOverpassClient({
      baseUrl: 'https://overpass.example.org/api/interpreter',
      timeoutMs: 5000,
      fetchImpl: overpass.fetchImpl,
      sleepFn: () => Promise.resolve(),
      maxRetryDelayMs: 0,
    }),
    routingClient: createOsrmEngineRoutingAdapter(osrmClient),
    placesPerArea: 30,
    maxOsrmRequests: extra.maxOsrmRequests ?? 60,
    now: () => NOW,
  };
}

describe('optimization happy path (mocked Overpass + OSRM)', () => {
  it('ranks 3 places x 2 participants with explanations and honest stats', async () => {
    const osrm = osrmStub();
    const overpass = overpassStub();
    const result = await runOptimization(input(), liveDeps(osrm, overpass));
    expect(result.provider).toBe('osrm');
    expect(result.ranked.map((r) => r.candidate.name)).toEqual([
      'Mock Corner Café',
      'Mock Garden Café',
      'Mock Riverside Café',
    ]);
    expect(result.ranked[0].rank).toBe(1);
    expect(result.ranked[0].totalMin).toBe(30);
    expect(result.ranked[0].explanation).toContain('Balanced score');
    expect(result.excluded).toEqual([]);
    // 5 fixture elements: 1 unnamed dropped, 1 duplicate removed -> 3 places.
    expect(result.stats.discovered).toBe(3);
    expect(result.stats.invalidRemoved).toBe(1);
    expect(result.stats.duplicatesRemoved).toBe(1);
    expect(result.stats.considered).toBe(3);
    expect(result.stats.routePairs).toBe(6);
    expect(result.stats.routeFailures).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/no traffic/);
    expect(osrm.calls()).toBe(6);
    expect(overpass.calls()).toBe(1);
    // Travel results carry OSRM geometry + source.
    expect(result.ranked[0].perParticipant.every((r) => r.source === 'osrm' && r.reachable)).toBe(true);
    expect(result.ranked[0].perParticipant[0].geometry?.length).toBe(2);
  });

  it('excludes unreachable candidates instead of estimating them', async () => {
    const osrm = osrmStub({ noRouteLng: 77.66 });
    const overpass = overpassStub();
    const result = await runOptimization(input(), liveDeps(osrm, overpass));
    expect(result.ranked.map((r) => r.candidate.name)).toEqual(['Mock Corner Café', 'Mock Garden Café']);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].candidate.name).toBe('Mock Riverside Café');
    expect(result.excluded[0].reason).toMatch(/Unreachable/);
    expect(result.stats.routeFailures).toBe(2);
  });

  it('applies the max-travel constraint', async () => {
    const osrm = osrmStub();
    const overpass = overpassStub();
    const result = await runOptimization(input({ maxTravelMinutes: 20 }), liveDeps(osrm, overpass));
    expect(result.ranked.map((r) => r.candidate.name)).toEqual(['Mock Corner Café']);
    expect(result.excluded).toHaveLength(2);
    expect(result.excluded[0].reason).toMatch(/20-minute/);
  });
});

describe('optimization failure modes (mocked APIs)', () => {
  it('Overpass persistent 429 -> clear error, no results, bounded retries across endpoints', async () => {
    const osrm = osrmStub();
    const overpass = overpassStub({ fail429Count: Infinity });
    await expect(runOptimization(input(), liveDeps(osrm, overpass))).rejects.toBeInstanceOf(EngineUnavailableError);
    // One retry per endpoint, three endpoints in the fallback chain: 6 calls, no retry storm.
    expect(overpass.calls()).toBe(6);
    expect(osrm.calls()).toBe(0); // no routing attempted without places
    try {
      await runOptimization(input(), liveDeps(osrm, overpassStub({ fail429Count: Infinity })));
      expect.unreachable();
    } catch (err) {
      expect((err as EngineUnavailableError).userMessage).toMatch(/rate-limited/);
    }
  });

  it('Overpass 429 then success -> retry succeeds', async () => {
    const osrm = osrmStub();
    const overpass = overpassStub({ fail429Count: 1 });
    const result = await runOptimization(input(), liveDeps(osrm, overpass));
    expect(result.ranked).toHaveLength(3);
    expect(overpass.calls()).toBe(2);
  });

  it('OSRM total failure -> EngineUnavailableError with NO fallback results', async () => {
    const osrm = osrmStub({ failAll: true });
    const overpass = overpassStub();
    await expect(runOptimization(input(), liveDeps(osrm, overpass))).rejects.toBeInstanceOf(EngineUnavailableError);
    try {
      await runOptimization(input(), liveDeps(osrmStub({ failAll: true }), overpassStub()));
      expect.unreachable();
    } catch (err) {
      expect((err as EngineUnavailableError).userMessage).toMatch(/Live routing is unavailable/);
      expect((err as EngineUnavailableError).userMessage).toMatch(/No estimates shown/);
    }
  });

  it('zero places -> EngineNoPlacesError naming the category', async () => {
    const osrm = osrmStub();
    const overpass = overpassStub({ payload: { elements: [] } });
    await expect(runOptimization(input(), liveDeps(osrm, overpass))).rejects.toBeInstanceOf(EngineNoPlacesError);
    expect(osrm.calls()).toBe(0);
  });

  it('validation failure happens before any network call', async () => {
    const osrm = osrmStub();
    const overpass = overpassStub();
    const bad = input({
      origins: [origin({ locationExpiresAt: '2026-11-17T11:00:00.000Z' }), origin({ participantId: 'p2' })],
    });
    await expect(runOptimization(bad, liveDeps(osrm, overpass))).rejects.toBeInstanceOf(OptimizationValidationError);
    expect(osrm.calls()).toBe(0);
    expect(overpass.calls()).toBe(0);
  });
});

describe('optimization budgets + dedup + batching (mocked APIs)', () => {
  it('dedups identical route pairs: co-located origins share one request per candidate', async () => {
    const osrm = osrmStub();
    const overpass = overpassStub({ payload: NEARBY_PAYLOAD });
    const sameSpot = input({
      origins: [
        origin(),
        origin({ participantId: 'p2', displayName: 'Priya', lat: 12.9716, lng: 77.6412, mode: 'car' }),
      ],
    });
    const result = await runOptimization(sameSpot, liveDeps(osrm, overpass));
    expect(result.stats.routePairs).toBe(3);
    expect(osrm.calls()).toBe(3);
    // Both participants still get results (shared geometry).
    expect(result.ranked[0].perParticipant).toHaveLength(2);
  });

  it('quota budget exceeded -> clear error before any routing call', async () => {
    const osrm = osrmStub();
    const overpass = overpassStub();
    await expect(runOptimization(input(), liveDeps(osrm, overpass, { maxOsrmRequests: 4 }))).rejects.toBeInstanceOf(
      EngineQuotaError,
    );
    expect(osrm.calls()).toBe(0);
    try {
      await runOptimization(input(), liveDeps(osrmStub(), overpassStub(), { maxOsrmRequests: 4 }));
      expect.unreachable();
    } catch (err) {
      expect((err as EngineQuotaError).userMessage).toMatch(/6 route requests/);
      expect((err as EngineQuotaError).userMessage).toMatch(/limit of 4/);
    }
  });

  it('groups route requests by OSRM profile', async () => {
    const osrm = osrmStub();
    const overpass = overpassStub({ payload: NEARBY_PAYLOAD });
    const mixed = input({
      memberParticipantIds: ['p1', 'p2', 'p3'],
      requiredParticipantIds: ['p1', 'p2', 'p3'],
      origins: [
        origin({ mode: 'car' }),
        origin({ participantId: 'p2', displayName: 'Priya', mode: 'walk' }),
        origin({ participantId: 'p3', displayName: 'Rohan', mode: 'scooter' }),
      ],
      maxCandidates: 1,
    });
    await runOptimization(mixed, liveDeps(osrm, overpass));
    const profiles = osrm.urls.map((u) => /\/route\/v1\/(\w+)\//.exec(u)?.[1]);
    // Scooter shares the driving profile with car (no motorcycle
    // profile on the demo server), so same-coord car+scooter origins
    // dedup into one driving request; walk stays on foot.
    expect(profiles).toEqual(['driving', 'foot']);
  });
});

describe('demo path (mock places + demo routing)', () => {
  it('ranks demo places with demo-labelled results', async () => {
    const demoPlaces = [
      { osmId: 'mock/a', name: 'Demo A', category: 'Café', lat: 12.95, lng: 77.64, source: 'mock' as const },
      { osmId: 'mock/b', name: 'Demo B', category: 'Café', lat: 12.96, lng: 77.65, source: 'mock' as const },
    ];
    const result = await runOptimization(input(), {
      placesClient: createMockPlacesClient(demoPlaces),
      routingClient: createDemoEngineRoutingAdapter(),
      now: () => NOW,
    });
    expect(result.provider).toBe('demo');
    expect(result.ranked).toHaveLength(2);
    expect(result.ranked.every((r) => r.perParticipant.every((p) => p.source === 'demo'))).toBe(true);
    expect(result.stats.routeFailures).toBe(0);
  });
});
