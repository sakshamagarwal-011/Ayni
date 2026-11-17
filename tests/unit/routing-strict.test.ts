import { describe, expect, it } from 'vitest';
import { createOsrmClient, type FetchLike } from '../../src/map/routing';

const FROM = { lat: 12.9716, lng: 77.6412 };
const TO = { lat: 12.9352, lng: 77.6245 };

const OSRM_OK = {
  code: 'Ok',
  routes: [
    {
      distance: 5234,
      duration: 1200,
      geometry: { type: 'LineString', coordinates: [[77.6412, 12.9716], [77.6245, 12.9352]] },
    },
  ],
};

function countingFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  let calls = 0;
  const urls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls += 1;
    urls.push(url);
    return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => payload };
  };
  return { fetchFn, calls: () => calls, urls };
}

function client(fetchFn: FetchLike) {
  return createOsrmClient({
    baseUrl: 'https://router.example.org',
    minIntervalMs: 0,
    timeoutMs: 5000,
    cacheTtlMs: 600_000,
    fetchFn,
  });
}

describe('fetchRouteStrict', () => {
  it('returns the parsed route on success', async () => {
    const { fetchFn } = countingFetch(OSRM_OK);
    const geometry = await client(fetchFn).fetchRouteStrict(FROM, TO, 'car');
    expect(geometry).not.toBeNull();
    expect(geometry!.source).toBe('osrm');
    expect(geometry!.distanceM).toBe(5234);
    expect(geometry!.durationMin).toBe(20);
  });

  it('returns null (never a fallback) on HTTP failure', async () => {
    const { fetchFn } = countingFetch({}, { ok: false, status: 429 });
    expect(await client(fetchFn).fetchRouteStrict(FROM, TO, 'car')).toBeNull();
  });

  it('returns null on a NoRoute payload and on malformed payloads', async () => {
    const { fetchFn: noRoute } = countingFetch({ code: 'NoRoute', routes: [] });
    expect(await client(noRoute).fetchRouteStrict(FROM, TO, 'car')).toBeNull();
    const { fetchFn: malformed } = countingFetch({ code: 'Ok', routes: [{ distance: 1 }] });
    expect(await client(malformed).fetchRouteStrict(FROM, TO, 'car')).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const throwing: FetchLike = async () => {
      throw new Error('network down');
    };
    expect(await client(throwing).fetchRouteStrict(FROM, TO, 'car')).toBeNull();
  });

  it('shares the cache with the lenient client: a strict success is reused', async () => {
    const stub = countingFetch(OSRM_OK);
    const c = client(stub.fetchFn);
    await c.fetchRouteStrict(FROM, TO, 'car');
    await c.fetchRoute(FROM, TO, 'car');
    expect(stub.calls()).toBe(1);
  });

  it('fetchRoutesStrict returns per-entry nulls in order', async () => {
    let n = 0;
    const fetchFn: FetchLike = async () => {
      n += 1;
      if (n === 2) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => OSRM_OK };
    };
    const results = await client(fetchFn).fetchRoutesStrict([
      { from: FROM, to: TO, mode: 'car' },
      { from: FROM, to: { lat: 12.9, lng: 77.6 }, mode: 'car' },
    ]);
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBeNull();
  });

  it('propagates external aborts', async () => {
    const fetchFn: FetchLike = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, status: 200, json: async () => OSRM_OK };
    };
    const controller = new AbortController();
    const promise = client(fetchFn).fetchRouteStrict(FROM, TO, 'car', controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(DOMException);
  });
});
