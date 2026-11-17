import { describe, expect, it, vi } from 'vitest';
import {
  EngineUnavailableError,
  createProxyPlacesClient,
  type ProxyPlacesInvokeFn,
  type SearchArea,
} from '../../src/engine';

/**
 * Proxy places client tests with a mocked invokeFn (no network).
 * Covers: structured-params invocation, success mapping incl. endpoint
 * passthrough, circle filtering + honest counts, invalid-entry drops,
 * 502/error → EngineUnavailableError, client timeout → timeout
 * message, abort ending the wait, and query-keyed cache + in-flight
 * dedup.
 */

const AREA: SearchArea = { centerLat: 12.9716, centerLng: 77.6412, radiusKm: 5, reason: 'test' };

const ENDPOINT = 'https://overpass.kumi.systems/api/interpreter';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    places: [
      {
        osmId: 'node/1',
        name: 'Test Café',
        category: 'Café',
        lat: 12.975,
        lng: 77.64,
        address: '100 Ft Road',
      },
      { osmId: 'way/2', name: 'Second Café', category: 'Café', lat: 12.97, lng: 77.645 },
    ],
    dropped: 3,
    duplicatesRemoved: 1,
    outsideCircle: 2,
    endpoint: ENDPOINT,
    ...overrides,
  };
}

function okInvoke(data: unknown) {
  // Unannotated on purpose: callers assert mock call counts, which
  // need the inferred Mock type (a ProxyPlacesInvokeFn annotation
  // would hide toHaveBeenCalled* from the type checker).
  return vi.fn(async () => ({ data, error: null }));
}

describe('createProxyPlacesClient', () => {
  it('invokes places-search with structured params (never raw QL)', async () => {
    const invokeFn = okInvoke(payload());
    const client = createProxyPlacesClient({ invokeFn });
    expect(client.provider).toBe('proxy');
    await client.search(AREA, 'cafe', 30);
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(invokeFn).toHaveBeenCalledWith('places-search', {
      body: { centerLat: 12.9716, centerLng: 77.6412, radiusKm: 5, category: 'cafe', limit: 30 },
    });
  });

  it('maps places to CandidatePlace with source overpass and passes the endpoint through', async () => {
    const client = createProxyPlacesClient({ invokeFn: okInvoke(payload()) });
    const result = await client.search(AREA, 'cafe', 30);
    expect(result.endpoint).toBe(ENDPOINT);
    expect(result.dropped).toBe(3);
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.outsideCircle).toBe(2);
    expect(result.places).toEqual([
      {
        osmId: 'node/1',
        name: 'Test Café',
        category: 'Café',
        lat: 12.975,
        lng: 77.64,
        address: '100 Ft Road',
        source: 'overpass',
      },
      {
        osmId: 'way/2',
        name: 'Second Café',
        category: 'Café',
        lat: 12.97,
        lng: 77.645,
        address: undefined,
        source: 'overpass',
      },
    ]);
  });

  it('trims places outside the circle client-side and folds them into the counts', async () => {
    const data = payload({
      places: [
        { osmId: 'node/1', name: 'Near Café', category: 'Café', lat: 12.975, lng: 77.64 },
        // ~59 km away: inside the query bbox corner only if the server
        // failed to trim; the client must never let it through.
        { osmId: 'node/9', name: 'Far Café', category: 'Café', lat: 13.5, lng: 77.6 },
      ],
      dropped: 0,
      outsideCircle: 0,
    });
    const client = createProxyPlacesClient({ invokeFn: okInvoke(data) });
    const result = await client.search(AREA, 'cafe', 30);
    expect(result.places.map((p) => p.osmId)).toEqual(['node/1']);
    expect(result.outsideCircle).toBe(1);
    expect(result.dropped).toBe(1);
  });

  it('drops invalid entries and counts them, keeping valid places', async () => {
    const data = payload({
      places: [
        { osmId: 'node/1', name: 'Good Café', category: 'Café', lat: 12.975, lng: 77.64 },
        { osmId: 'node/2', name: '  ', category: 'Café', lat: 12.975, lng: 77.64 },
        { osmId: 'node/3', name: 'No Coords', category: 'Café' },
        { osmId: 'node/4', name: 'Out Of Range', category: 'Café', lat: 120, lng: 77.64 },
        { name: 'No Id', category: 'Café', lat: 12.975, lng: 77.64 },
        'not-an-object',
      ],
      dropped: 1,
      outsideCircle: 0,
    });
    const client = createProxyPlacesClient({ invokeFn: okInvoke(data) });
    const result = await client.search(AREA, 'cafe', 30);
    expect(result.places.map((p) => p.osmId)).toEqual(['node/1']);
    // 1 server-side drop + 5 invalid entries.
    expect(result.dropped).toBe(6);
  });

  it('defaults a missing category label to Place instead of dropping the place', async () => {
    const data = payload({
      places: [{ osmId: 'node/1', name: 'Unlabelled', lat: 12.975, lng: 77.64 }],
      dropped: 0,
      outsideCircle: 0,
    });
    const client = createProxyPlacesClient({ invokeFn: okInvoke(data) });
    const result = await client.search(AREA, 'cafe', 30);
    expect(result.places[0]?.category).toBe('Place');
  });

  it('maps an invoke error (e.g. the function 502) to EngineUnavailableError', async () => {
    const invokeFn: ProxyPlacesInvokeFn = vi.fn(async () => ({ data: null, error: new Error('Edge Function 502') }));
    const client = createProxyPlacesClient({ invokeFn });
    await expect(client.search(AREA, 'cafe', 30)).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(client.search(AREA, 'cafe', 30)).rejects.toThrow(
      'Live place search is unavailable — try again later. No estimates shown.',
    );
  });

  it('maps malformed payloads to EngineUnavailableError', async () => {
    for (const data of [null, {}, { places: 'nope' }, { places: null }, 42]) {
      const client = createProxyPlacesClient({ invokeFn: okInvoke(data) });
      await expect(client.search(AREA, 'cafe', 30)).rejects.toBeInstanceOf(EngineUnavailableError);
    }
  });

  it('maps a throwing invokeFn to EngineUnavailableError', async () => {
    const invokeFn: ProxyPlacesInvokeFn = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = createProxyPlacesClient({ invokeFn });
    await expect(client.search(AREA, 'cafe', 30)).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  it('times out with the timeout message when the invocation hangs', async () => {
    const invokeFn: ProxyPlacesInvokeFn = vi.fn(
      () => new Promise<{ data: unknown; error: unknown }>(() => {}),
    );
    const client = createProxyPlacesClient({ invokeFn, timeoutMs: 10 });
    await expect(client.search(AREA, 'cafe', 30)).rejects.toThrow(
      'Live place search timed out — try again later. No estimates shown.',
    );
  });

  it('ends the wait promptly when the caller aborts', async () => {
    const invokeFn: ProxyPlacesInvokeFn = vi.fn(
      () => new Promise<{ data: unknown; error: unknown }>(() => {}),
    );
    const client = createProxyPlacesClient({ invokeFn, timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = client.search(AREA, 'cafe', 30, controller.signal);
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('caches by structured query: identical searches invoke once, different params invoke again', async () => {
    const invokeFn = okInvoke(payload());
    const client = createProxyPlacesClient({ invokeFn });
    await client.search(AREA, 'cafe', 30);
    await client.search(AREA, 'cafe', 30);
    expect(invokeFn).toHaveBeenCalledTimes(1);
    await client.search(AREA, 'restaurant', 30);
    expect(invokeFn).toHaveBeenCalledTimes(2);
    await client.search({ ...AREA, centerLat: 12.9 }, 'cafe', 30);
    expect(invokeFn).toHaveBeenCalledTimes(3);
    await client.search(AREA, 'cafe', 10);
    expect(invokeFn).toHaveBeenCalledTimes(4);
  });

  it('shares one in-flight invocation between concurrent identical searches', async () => {
    let release!: (value: { data: unknown; error: null }) => void;
    const gate = new Promise<{ data: unknown; error: null }>((resolve) => {
      release = resolve;
    });
    const invokeFn = vi.fn(() => gate);
    const client = createProxyPlacesClient({ invokeFn });
    const first = client.search(AREA, 'cafe', 30);
    const second = client.search(AREA, 'cafe', 30);
    release({ data: payload(), error: null });
    const [a, b] = await Promise.all([first, second]);
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('re-invokes after the cache TTL expires', async () => {
    let t = 1_000_000;
    const invokeFn = okInvoke(payload());
    const client = createProxyPlacesClient({ invokeFn, cacheTtlMs: 1000, now: () => t });
    await client.search(AREA, 'cafe', 30);
    await client.search(AREA, 'cafe', 30);
    expect(invokeFn).toHaveBeenCalledTimes(1);
    t += 1001;
    await client.search(AREA, 'cafe', 30);
    expect(invokeFn).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const failing = vi.fn(async () => ({ data: null, error: new Error('boom') }));
    const client = createProxyPlacesClient({ invokeFn: failing });
    await expect(client.search(AREA, 'cafe', 30)).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(client.search(AREA, 'cafe', 30)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
