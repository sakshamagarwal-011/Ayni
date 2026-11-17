import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERPASS_URL,
  EngineUnavailableError,
  OVERPASS_MIRROR_URLS,
  createOverpassClient,
  resolveOverpassEndpoints,
  type OverpassFetchLike,
  type SearchArea,
} from '../../src/engine';

/**
 * Overpass client tests with a mocked fetch (no network). Covers the
 * endpoint fallback chain: the configured endpoint is tried first,
 * mirrors are fallback only, aborts stop the chain, and the cache
 * stays keyed by query (not endpoint).
 */

const AREA: SearchArea = { centerLat: 12.9716, centerLng: 77.6412, radiusKm: 5, reason: 'test' };

const PAYLOAD = {
  elements: [
    { id: 1, lat: 12.95, lon: 77.64, type: 'node', tags: { name: 'Test Café', amenity: 'cafe' } },
  ],
};

const KUMI = 'https://overpass.kumi.systems/api/interpreter';
const PRIVATE_COFFEE = 'https://overpass.private.coffee/api/interpreter';

function okResponse(payload: unknown = PAYLOAD) {
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

describe('resolveOverpassEndpoints', () => {
  it('tries the configured URL first, then the built-in mirrors in order', () => {
    expect(resolveOverpassEndpoints(DEFAULT_OVERPASS_URL)).toEqual([DEFAULT_OVERPASS_URL, KUMI, PRIVATE_COFFEE]);
    expect(OVERPASS_MIRROR_URLS).toEqual([KUMI, PRIVATE_COFFEE]);
  });

  it('honours a custom configured URL as the first endpoint', () => {
    expect(resolveOverpassEndpoints('https://overpass.example.org/api/interpreter')).toEqual([
      'https://overpass.example.org/api/interpreter',
      KUMI,
      PRIVATE_COFFEE,
    ]);
  });

  it('deduplicates a configured URL that equals a mirror (trailing slash included)', () => {
    expect(resolveOverpassEndpoints(KUMI)).toEqual([KUMI, PRIVATE_COFFEE]);
    expect(resolveOverpassEndpoints(`${PRIVATE_COFFEE}/`)).toEqual([PRIVATE_COFFEE, KUMI]);
  });
});

describe('Overpass endpoint fallback', () => {
  it('first endpoint 406 -> second endpoint succeeds and is reported', async () => {
    const urls: string[] = [];
    const fetchImpl: OverpassFetchLike = async (url) => {
      urls.push(url);
      if (url === DEFAULT_OVERPASS_URL) return errorResponse(406);
      return okResponse();
    };
    const client = createOverpassClient({ baseUrl: DEFAULT_OVERPASS_URL, timeoutMs: 5000, fetchImpl });
    const result = await client.search(AREA, 'cafe', 30);
    expect(urls).toEqual([DEFAULT_OVERPASS_URL, KUMI]);
    expect(result.places).toHaveLength(1);
    expect(result.places[0].name).toBe('Test Café');
    expect(result.endpoint).toBe(KUMI);
  });

  it('configured URL is tried first and a success there never touches the mirrors', async () => {
    const urls: string[] = [];
    const custom = 'https://overpass.example.org/api/interpreter';
    const fetchImpl: OverpassFetchLike = async (url) => {
      urls.push(url);
      return okResponse();
    };
    const client = createOverpassClient({ baseUrl: custom, timeoutMs: 5000, fetchImpl });
    const result = await client.search(AREA, 'cafe', 30);
    expect(urls).toEqual([custom]);
    expect(result.endpoint).toBe(custom);
  });

  it('all endpoints fail -> EngineUnavailableError with the default message, no results', async () => {
    const urls: string[] = [];
    const fetchImpl: OverpassFetchLike = async (url) => {
      urls.push(url);
      return errorResponse(500);
    };
    const client = createOverpassClient({ baseUrl: DEFAULT_OVERPASS_URL, timeoutMs: 5000, fetchImpl });
    await expect(client.search(AREA, 'cafe', 30)).rejects.toBeInstanceOf(EngineUnavailableError);
    // One attempt per endpoint (500 is not retried), all three tried in order.
    expect(urls).toEqual([DEFAULT_OVERPASS_URL, KUMI, PRIVATE_COFFEE]);
    try {
      await client.search(AREA, 'cafe', 30);
      expect.unreachable();
    } catch (err) {
      expect((err as EngineUnavailableError).userMessage).toBe(
        'Live place search is unavailable — try again later. No estimates shown.',
      );
    }
  });

  it('invalid JSON on the first endpoint -> next endpoint succeeds', async () => {
    const urls: string[] = [];
    const fetchImpl: OverpassFetchLike = async (url) => {
      urls.push(url);
      if (url === DEFAULT_OVERPASS_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        };
      }
      return okResponse();
    };
    const client = createOverpassClient({ baseUrl: DEFAULT_OVERPASS_URL, timeoutMs: 5000, fetchImpl });
    const result = await client.search(AREA, 'cafe', 30);
    expect(urls).toEqual([DEFAULT_OVERPASS_URL, KUMI]);
    expect(result.places).toHaveLength(1);
    expect(result.endpoint).toBe(KUMI);
  });

  it('persistent 429 on one endpoint -> one retry there, then the next endpoint', async () => {
    const urls: string[] = [];
    const fetchImpl: OverpassFetchLike = async (url) => {
      urls.push(url);
      if (url === DEFAULT_OVERPASS_URL) return errorResponse(429, '0');
      return okResponse();
    };
    const client = createOverpassClient({
      baseUrl: DEFAULT_OVERPASS_URL,
      timeoutMs: 5000,
      fetchImpl,
      sleepFn: () => Promise.resolve(),
      maxRetryDelayMs: 0,
    });
    const result = await client.search(AREA, 'cafe', 30);
    // Initial + one retry on the first endpoint, then success on the mirror.
    expect(urls).toEqual([DEFAULT_OVERPASS_URL, DEFAULT_OVERPASS_URL, KUMI]);
    expect(result.places).toHaveLength(1);
    expect(result.endpoint).toBe(KUMI);
  });

  it('abort mid-chain stops further requests (no more endpoints tried)', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl: OverpassFetchLike = async (_url, init) => {
      calls += 1;
      // Simulate a hanging first endpoint; the user aborts while waiting.
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
    const client = createOverpassClient({ baseUrl: DEFAULT_OVERPASS_URL, timeoutMs: 5000, fetchImpl });
    await expect(client.search(AREA, 'cafe', 30, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('an already-aborted signal issues no requests at all', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetchImpl: OverpassFetchLike = async () => {
      calls += 1;
      return okResponse();
    };
    const client = createOverpassClient({ baseUrl: DEFAULT_OVERPASS_URL, timeoutMs: 5000, fetchImpl });
    await expect(client.search(AREA, 'cafe', 30, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });

  it('cache stays keyed by query: repeat searches hit the cache, new queries re-run the chain', async () => {
    const urls: string[] = [];
    const fetchImpl: OverpassFetchLike = async (url) => {
      urls.push(url);
      if (url === DEFAULT_OVERPASS_URL) return errorResponse(406);
      return okResponse();
    };
    const client = createOverpassClient({ baseUrl: DEFAULT_OVERPASS_URL, timeoutMs: 5000, fetchImpl });
    const first = await client.search(AREA, 'cafe', 30);
    const cached = await client.search(AREA, 'cafe', 30);
    expect(urls).toEqual([DEFAULT_OVERPASS_URL, KUMI]);
    expect(cached).toBe(first);
    expect(cached.endpoint).toBe(KUMI);
    // A different category builds a different query: the chain runs again.
    await client.search(AREA, 'park', 30);
    expect(urls).toEqual([DEFAULT_OVERPASS_URL, KUMI, DEFAULT_OVERPASS_URL, KUMI]);
  });
});

describe('Overpass bbox query + circle filter', () => {
  it('sends a bbox query (no around, no relations) and trims corner places, counting them', async () => {
    const bodies: string[] = [];
    const payload = {
      elements: [
        { id: 1, lat: 12.95, lon: 77.64, type: 'node', tags: { name: 'Inside Café', amenity: 'cafe' } },
        // Bbox corner of AREA's 5 km circle: ~7.1 km from the centre.
        { id: 2, lat: 13.01657, lon: 77.68734, type: 'node', tags: { name: 'Corner Café', amenity: 'cafe' } },
      ],
    };
    const fetchImpl: OverpassFetchLike = async (_url, init) => {
      bodies.push(init?.body ?? '');
      return okResponse(payload);
    };
    const client = createOverpassClient({ baseUrl: DEFAULT_OVERPASS_URL, timeoutMs: 5000, fetchImpl });
    const result = await client.search(AREA, 'cafe', 30);
    expect(bodies).toHaveLength(1);
    const sent = decodeURIComponent(bodies[0].replace(/^data=/, ''));
    expect(sent).toContain('(12.92663,77.59506,13.01657,77.68734)');
    expect(sent).not.toContain('around');
    expect(sent).not.toContain('relation');
    expect(result.places.map((p) => p.name)).toEqual(['Inside Café']);
    expect(result.outsideCircle).toBe(1);
    expect(result.dropped).toBe(1);
  });

  it('derives the QL timeout from the client timeout (45s default -> timeout:45)', async () => {
    const bodies: string[] = [];
    const fetchImpl: OverpassFetchLike = async (_url, init) => {
      bodies.push(init?.body ?? '');
      return okResponse();
    };
    const client = createOverpassClient({ baseUrl: DEFAULT_OVERPASS_URL, timeoutMs: 45_000, fetchImpl });
    await client.search(AREA, 'cafe', 30);
    expect(decodeURIComponent(bodies[0].replace(/^data=/, ''))).toContain('[out:json][timeout:45]');
  });
});
