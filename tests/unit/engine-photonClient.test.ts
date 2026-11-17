import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHOTON_URL,
  EngineUnavailableError,
  PHOTON_INCLUDE_CATEGORIES,
  buildPhotonRequestUrl,
  createPhotonClient,
  getSharedPhotonClient,
  parsePhotonResponse,
  photonPerCategoryLimit,
  type PhotonFetchLike,
  type SearchArea,
} from '../../src/engine';

/**
 * Photon client tests with a mocked fetch (no network). Covers the
 * category-request shape (bbox order, include values, limit
 * splitting), GeoJSON parsing/dedup/circle-filtering, retry/timeout/
 * abort discipline, the throttle gap, and the query-keyed cache.
 */

const AREA: SearchArea = { centerLat: 12.9716, centerLng: 77.6412, radiusKm: 5, reason: 'test' };
// bboxForSearchArea(AREA): south 12.92663, west 77.59506, north 13.01657, east 77.68734.
const PHOTON_BBOX = '77.59506,12.92663,77.68734,13.01657';

const BASE = 'https://photon.komoot.io';

function cafeFeature(overrides: Record<string, unknown> = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [77.64, 12.95] },
    properties: {
      name: 'Test Café',
      osm_id: 1,
      osm_type: 'N',
      osm_key: 'amenity',
      osm_value: 'cafe',
      housenumber: '42',
      street: '100 Feet Road',
      suburb: 'Indiranagar',
      city: 'Bengaluru',
      ...overrides,
    },
  };
}

function collection(features: unknown[]) {
  return { type: 'FeatureCollection', features };
}

function okResponse(payload: unknown = collection([cafeFeature()])) {
  return { ok: true, status: 200, json: async () => payload };
}

function errorResponse(status: number, retryAfter?: string) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
    json: async () => ({}),
  };
}

/** Fast client for tests: no throttle gap, immediate sleeps. */
function testClient(fetchImpl: PhotonFetchLike, extra: Record<string, unknown> = {}) {
  return createPhotonClient({
    baseUrl: BASE,
    timeoutMs: 5000,
    minGapMs: 0,
    fetchImpl,
    sleepFn: () => Promise.resolve(),
    ...extra,
  });
}

describe('PHOTON_INCLUDE_CATEGORIES', () => {
  it('maps single-tag categories to one include value', () => {
    expect(PHOTON_INCLUDE_CATEGORIES.cafe).toEqual(['osm.amenity.cafe']);
    expect(PHOTON_INCLUDE_CATEGORIES.restaurant).toEqual(['osm.amenity.restaurant']);
    expect(PHOTON_INCLUDE_CATEGORIES.park).toEqual(['osm.leisure.park']);
    expect(PHOTON_INCLUDE_CATEGORIES.mall).toEqual(['osm.shop.mall']);
  });

  it('maps multi-tag categories to one include per tag', () => {
    expect(PHOTON_INCLUDE_CATEGORIES.bar).toEqual(['osm.amenity.bar', 'osm.amenity.pub']);
    expect(PHOTON_INCLUDE_CATEGORIES.teaStall).toEqual(['osm.amenity.cafe', 'osm.amenity.fast_food']);
  });

  it('returns all stations for metroStation (subway/light_rail indistinguishable in Photon)', () => {
    expect(PHOTON_INCLUDE_CATEGORIES.metroStation).toEqual(['osm.railway.station']);
    expect(PHOTON_INCLUDE_CATEGORIES.railwayStation).toEqual(['osm.railway.station']);
  });

  it('covers every category in `any` (11 includes, no tea/cuisine filter)', () => {
    expect(PHOTON_INCLUDE_CATEGORIES.any).toEqual([
      'osm.amenity.cafe',
      'osm.amenity.restaurant',
      'osm.amenity.bar',
      'osm.amenity.pub',
      'osm.amenity.fast_food',
      'osm.leisure.park',
      'osm.amenity.library',
      'osm.office.coworking',
      'osm.shop.mall',
      'osm.railway.station',
      'osm.amenity.marketplace',
    ]);
  });
});

describe('photonPerCategoryLimit', () => {
  it('splits the area limit across categories, at least 3 each', () => {
    expect(photonPerCategoryLimit(30, 1)).toBe(30);
    expect(photonPerCategoryLimit(30, 2)).toBe(15);
    expect(photonPerCategoryLimit(30, 11)).toBe(3);
    expect(photonPerCategoryLimit(10, 11)).toBe(3);
    expect(photonPerCategoryLimit(1, 1)).toBe(3);
  });
});

describe('buildPhotonRequestUrl', () => {
  it('builds a category-only search with Photon bbox order (west,south,east,north)', () => {
    const url = buildPhotonRequestUrl(BASE, AREA, 'osm.amenity.cafe', 30);
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${BASE}/api/`);
    expect(parsed.searchParams.get('include')).toBe('osm.amenity.cafe');
    expect(parsed.searchParams.get('bbox')).toBe(PHOTON_BBOX);
    expect(parsed.searchParams.get('lat')).toBe('12.97160');
    expect(parsed.searchParams.get('lon')).toBe('77.64120');
    expect(parsed.searchParams.get('limit')).toBe('30');
    expect(parsed.searchParams.get('lang')).toBe('en');
    // Category-only search: no free-text word.
    expect(parsed.searchParams.has('q')).toBe(false);
  });

  it('strips a trailing slash from the base URL (no double slash)', () => {
    expect(buildPhotonRequestUrl(`${BASE}/`, AREA, 'osm.amenity.cafe', 30)).toBe(
      buildPhotonRequestUrl(BASE, AREA, 'osm.amenity.cafe', 30),
    );
  });
});

describe('Photon request sequence', () => {
  it('issues one GET per include-category, sequentially, in map order', async () => {
    const urls: string[] = [];
    const fetchImpl: PhotonFetchLike = async (url) => {
      urls.push(url);
      return okResponse(collection([]));
    };
    const result = await testClient(fetchImpl).search(AREA, 'bar', 30);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).searchParams.get('include')).toBe('osm.amenity.bar');
    expect(new URL(urls[1]).searchParams.get('include')).toBe('osm.amenity.pub');
    expect(new URL(urls[0]).searchParams.get('limit')).toBe('15');
    expect(new URL(urls[1]).searchParams.get('limit')).toBe('15');
    expect(result.places).toEqual([]);
    expect(result.endpoint).toBe(BASE);
  });

  it('reports the normalized base URL as the serving endpoint', async () => {
    const fetchImpl: PhotonFetchLike = async () => okResponse();
    const client = createPhotonClient({
      baseUrl: `${BASE}/`,
      timeoutMs: 5000,
      minGapMs: 0,
      fetchImpl,
      sleepFn: () => Promise.resolve(),
    });
    const result = await client.search(AREA, 'cafe', 30);
    expect(result.endpoint).toBe(BASE);
  });

  it('enforces the minimum gap between request starts', async () => {
    const sleeps: number[] = [];
    const fetchImpl: PhotonFetchLike = async () => okResponse(collection([]));
    const client = createPhotonClient({
      baseUrl: BASE,
      timeoutMs: 5000,
      minGapMs: 1000,
      fetchImpl,
      // Fixed clock: every gap computes the full 1000ms.
      now: () => 1_000_000,
      sleepFn: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await client.search(AREA, 'bar', 30);
    // First request: no wait (no previous request). Second: full gap.
    expect(sleeps).toEqual([1000]);
  });
});

describe('parsePhotonResponse', () => {
  it('parses GeoJSON features: [lng, lat] coords, OSM identity, tags label, address', () => {
    const parsed = parsePhotonResponse(collection([cafeFeature()]), 'osm.amenity.cafe');
    expect(parsed.total).toBe(1);
    expect(parsed.dropped).toBe(0);
    expect(parsed.places).toEqual([
      {
        osmId: 'node/1',
        name: 'Test Café',
        category: 'Café',
        lat: 12.95,
        lng: 77.64,
        address: '42 100 Feet Road, Indiranagar, Bengaluru',
        tags: { amenity: 'cafe' },
        source: 'photon',
      },
    ]);
  });

  it('maps way/relation osm_type letters and full words', () => {
    const parsed = parsePhotonResponse(
      collection([
        cafeFeature({ osm_id: 7, osm_type: 'W', name: 'Way Café' }),
        cafeFeature({ osm_id: 9, osm_type: 'R', name: 'Relation Café' }),
        cafeFeature({ osm_id: 11, osm_type: 'node', name: 'Node Café' }),
        cafeFeature({ osm_id: '13', name: 'String Id Café' }),
      ]),
      'osm.amenity.cafe',
    );
    expect(parsed.places.map((p) => p.osmId)).toEqual(['way/7', 'relation/9', 'node/11', 'node/13']);
    expect(parsed.dropped).toBe(0);
  });

  it('labels stations as Railway station (no metro claim without a station tag)', () => {
    const parsed = parsePhotonResponse(
      collection([
        cafeFeature({
          name: 'Indiranagar Metro Station',
          osm_key: 'railway',
          osm_value: 'station',
        }),
      ]),
      'osm.railway.station',
    );
    expect(parsed.places[0].category).toBe('Railway station');
  });

  it('falls back to the requested include category when osm_key/osm_value are absent', () => {
    const feature = cafeFeature();
    delete (feature.properties as Record<string, unknown>).osm_key;
    delete (feature.properties as Record<string, unknown>).osm_value;
    const parsed = parsePhotonResponse(collection([feature]), 'osm.amenity.cafe');
    expect(parsed.places[0].category).toBe('Café');
    expect(parsed.places[0].tags).toEqual({ amenity: 'cafe' });
  });

  it('drops unnamed, coordinate-less, out-of-range, and identity-less features, counting them', () => {
    const parsed = parsePhotonResponse(
      collection([
        cafeFeature({ name: '' }),
        cafeFeature({ name: '   ' }),
        { type: 'Feature', geometry: null, properties: cafeFeature().properties },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [77.64] }, properties: cafeFeature().properties },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [77.64, 12.95] },
          properties: { ...cafeFeature().properties, name: 'No Id', osm_id: undefined },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [200, 12.95] },
          properties: { ...cafeFeature().properties, name: 'Bad Lng' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: ['77.64', 12.95] },
          properties: { ...cafeFeature().properties, name: 'String Coords' },
        },
        null,
        'not-a-feature',
      ]),
      'osm.amenity.cafe',
    );
    expect(parsed.places).toEqual([]);
    expect(parsed.dropped).toBe(9);
    expect(parsed.total).toBe(9);
  });

  it('never throws on malformed payloads', () => {
    expect(parsePhotonResponse(null, 'osm.amenity.cafe')).toEqual({ places: [], dropped: 0, total: 0 });
    expect(parsePhotonResponse('garbage', 'osm.amenity.cafe')).toEqual({ places: [], dropped: 0, total: 0 });
    expect(parsePhotonResponse({}, 'osm.amenity.cafe')).toEqual({ places: [], dropped: 0, total: 0 });
    expect(parsePhotonResponse({ features: 'nope' }, 'osm.amenity.cafe')).toEqual({
      places: [],
      dropped: 0,
      total: 0,
    });
  });

  it('assembles addresses from housenumber/street + suburb/district/city, skipping duplicates', () => {
    const parsed = parsePhotonResponse(
      collection([
        cafeFeature({ housenumber: undefined, street: undefined, suburb: 'Koramangala', district: 'Bengaluru', city: 'Bengaluru' }),
        cafeFeature({ osm_id: 2, name: 'No Address', housenumber: undefined, street: undefined, suburb: undefined, district: undefined, city: undefined }),
      ]),
      'osm.amenity.cafe',
    );
    expect(parsed.places[0].address).toBe('Koramangala, Bengaluru');
    expect(parsed.places[1].address).toBeUndefined();
  });
});

describe('Photon search: dedup, circle filter, cache', () => {
  it('deduplicates the same OSM object across categories (first wins)', async () => {
    const fetchImpl: PhotonFetchLike = async (url) => {
      const include = new URL(url).searchParams.get('include');
      const feature = cafeFeature({ osm_id: 5, name: include === 'osm.amenity.bar' ? 'Bar Name' : 'Pub Name' });
      return okResponse(collection([feature]));
    };
    const result = await testClient(fetchImpl).search(AREA, 'bar', 30);
    expect(result.places).toHaveLength(1);
    expect(result.places[0].name).toBe('Bar Name');
    expect(result.duplicatesRemoved).toBe(1);
  });

  it('trims bbox-corner places to the circle, counting them in dropped + outsideCircle', async () => {
    const payload = collection([
      cafeFeature({ osm_id: 1, name: 'Inside Café' }),
      // Bbox corner of AREA's 5 km circle: ~7.1 km from the centre.
      cafeFeature({
        osm_id: 2,
        name: 'Corner Café',
      }),
    ]);
    (payload.features[1] as { geometry: { coordinates: number[] } }).geometry.coordinates = [77.68734, 13.01657];
    const fetchImpl: PhotonFetchLike = async () => okResponse(payload);
    const result = await testClient(fetchImpl).search(AREA, 'cafe', 30);
    expect(result.places.map((p) => p.name)).toEqual(['Inside Café']);
    expect(result.outsideCircle).toBe(1);
    expect(result.dropped).toBe(1);
  });

  it('cache is keyed by search params: repeats hit the cache, new params re-run', async () => {
    const urls: string[] = [];
    const fetchImpl: PhotonFetchLike = async (url) => {
      urls.push(url);
      return okResponse();
    };
    const client = testClient(fetchImpl);
    const first = await client.search(AREA, 'cafe', 30);
    const cached = await client.search(AREA, 'cafe', 30);
    expect(urls).toHaveLength(1);
    expect(cached).toBe(first);
    await client.search(AREA, 'park', 30);
    expect(urls).toHaveLength(2);
    await client.search(AREA, 'cafe', 10);
    expect(urls).toHaveLength(3);
  });

  it('shares one in-flight sequence between concurrent identical searches', async () => {
    let calls = 0;
    const fetchImpl: PhotonFetchLike = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return okResponse();
    };
    const client = testClient(fetchImpl);
    const [a, b] = await Promise.all([client.search(AREA, 'cafe', 30), client.search(AREA, 'cafe', 30)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
});

describe('Photon failures', () => {
  it('a failed category fails the whole search (no partial category sets), uncached', async () => {
    const urls: string[] = [];
    const fetchImpl: PhotonFetchLike = async (url) => {
      urls.push(url);
      if (new URL(url).searchParams.get('include') === 'osm.amenity.pub') return errorResponse(500);
      return okResponse();
    };
    const client = testClient(fetchImpl);
    await expect(client.search(AREA, 'bar', 30)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(urls).toHaveLength(2);
    // Failures are not cached: the retry runs the sequence again.
    await expect(client.search(AREA, 'bar', 30)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(urls).toHaveLength(4);
  });

  it('non-retryable errors surface the default message with no retry', async () => {
    let calls = 0;
    const fetchImpl: PhotonFetchLike = async () => {
      calls += 1;
      return errorResponse(500);
    };
    try {
      await testClient(fetchImpl).search(AREA, 'cafe', 30);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineUnavailableError);
      expect((err as EngineUnavailableError).userMessage).toBe(
        'Live place search is unavailable — try again later. No estimates shown.',
      );
    }
    expect(calls).toBe(1);
  });

  it('invalid JSON surfaces the default unavailable message', async () => {
    const fetchImpl: PhotonFetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    await expect(testClient(fetchImpl).search(AREA, 'cafe', 30)).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  it('persistent 429 -> one retry honouring Retry-After, then the rate-limited message', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: PhotonFetchLike = async () => {
      calls += 1;
      return errorResponse(429, '2');
    };
    const client = createPhotonClient({
      baseUrl: BASE,
      timeoutMs: 5000,
      minGapMs: 0,
      fetchImpl,
      sleepFn: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    try {
      await client.search(AREA, 'cafe', 30);
      expect.unreachable();
    } catch (err) {
      expect((err as EngineUnavailableError).userMessage).toBe(
        'Place search is rate-limited right now — try again in a minute. No estimates shown.',
      );
    }
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('Retry-After is capped at 30s', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: PhotonFetchLike = async () => {
      calls += 1;
      if (calls === 1) return errorResponse(429, '120');
      return okResponse();
    };
    const client = createPhotonClient({
      baseUrl: BASE,
      timeoutMs: 5000,
      minGapMs: 0,
      fetchImpl,
      sleepFn: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const result = await client.search(AREA, 'cafe', 30);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([30_000]);
    expect(result.places).toHaveLength(1);
  });

  it('a 504 is retried once; a 429 that clears on retry succeeds', async () => {
    let calls = 0;
    const fetchImpl: PhotonFetchLike = async () => {
      calls += 1;
      if (calls === 1) return errorResponse(504);
      return okResponse();
    };
    const result = await testClient(fetchImpl).search(AREA, 'cafe', 30);
    expect(calls).toBe(2);
    expect(result.places).toHaveLength(1);
  });

  it('a hung request times out with the timeout message', async () => {
    const fetchImpl: PhotonFetchLike = async (_url, init) =>
      new Promise<never>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    const client = createPhotonClient({
      baseUrl: BASE,
      timeoutMs: 50,
      minGapMs: 0,
      fetchImpl,
      sleepFn: () => Promise.resolve(),
    });
    try {
      await client.search(AREA, 'cafe', 30);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineUnavailableError);
      expect((err as EngineUnavailableError).userMessage).toBe(
        'Live place search timed out — try again later. No estimates shown.',
      );
    }
  });

  it('abort mid-sequence stops further category requests', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl: PhotonFetchLike = async (_url, init) => {
      calls += 1;
      controller.abort();
      return new Promise<never>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    };
    await expect(testClient(fetchImpl).search(AREA, 'bar', 30, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(1);
  });

  it('an already-aborted signal issues no requests at all', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetchImpl: PhotonFetchLike = async () => {
      calls += 1;
      return okResponse();
    };
    await expect(testClient(fetchImpl).search(AREA, 'cafe', 30, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(0);
  });
});

describe('getSharedPhotonClient', () => {
  it('returns the same instance for the same endpoint + timeout', () => {
    const a = getSharedPhotonClient({ baseUrl: BASE });
    const b = getSharedPhotonClient({ baseUrl: BASE });
    expect(a).toBe(b);
    expect(a.provider).toBe('photon');
  });

  it('returns a different instance for a different endpoint', () => {
    const a = getSharedPhotonClient({ baseUrl: BASE });
    const other = getSharedPhotonClient({ baseUrl: 'https://photon.example.org' });
    expect(other).not.toBe(a);
  });

  it('uses the default Photon URL from config', () => {
    expect(DEFAULT_PHOTON_URL).toBe('https://photon.komoot.io');
  });
});
