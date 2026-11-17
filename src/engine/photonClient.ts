import { EngineError, EngineUnavailableError } from './errors';
import { bboxForSearchArea, categoryLabelForTags, deduplicatePlaces, filterPlacesToCircle } from './places';
import { shareInflight } from './placesClient';
import type { PlacesClient, PlacesSearchResult } from './placesClient';
import type { CandidatePlace, MeetingCategory, SearchArea } from './types';

/**
 * Photon (Komoot) places client (impure layer). Photon is a
 * search-as-a-service front end over OpenStreetMap data, backed by
 * Elasticsearch; it answers with GeoJSON and — unlike Overpass —
 * accepts category-only searches with NO search word, which is
 * exactly what meeting-point discovery needs.
 *
 * WHY PHOTON: live testing (2026-11-17) proved browsers on
 * cloud/datacenter networks cannot query Overpass directly
 * (overpass-api.de rejects them with HTTP 406, the small mirrors
 * time out server-side), and the Supabase proxy cannot reach
 * Overpass either (HTTP 502 from Supabase's network). Photon
 * category search was verified live in a browser on the same day:
 * `include=osm.amenity.cafe` + bbox returns real cafés regardless
 * of name, and `include=osm.railway.station` finds metro stations.
 * Photon is therefore the working live places path; Overpass
 * (direct + proxy) remains available via env for self-hosters.
 *
 * Mechanism: Photon categories carry ONLY the main OSM tag
 * (`osm.<key>.<value>`), so a meeting category maps to one or more
 * `include` values. ONE GET request is issued PER include-category,
 * strictly sequentially — verified live: comma-combined include
 * values do NOT mix; one category dominates the results. Each
 * request asks for a share of the area limit and is bounded by the
 * search-area bbox; results are trimmed back to the search circle
 * client-side (same honest counting as the Overpass client).
 *
 * HONEST APPROXIMATIONS (documented here and in ENGINE.md):
 * - metroStation returns ALL railway stations: Photon categories
 *   carry only the main tag, so `station=subway`/`light_rail`
 *   cannot be distinguished from other stations. Place labels come
 *   from tags, so stations show as "Railway station", never as a
 *   metro claim the data cannot support.
 * - teaStall returns cafés/fast-food in the circle: `cuisine` is a
 *   secondary tag Photon cannot filter on, so cuisine=tea cannot be
 *   required. Labels come from tags ("Café"/"Fast food"), never
 *   invented as tea stalls.
 *
 * Fair-use discipline, mirroring the other clients:
 * - Sequential requests only (never parallel), minimum 1000ms gap
 *   between request starts, 15s timeout per request.
 * - At most ONE retry, only on 429/504, honouring Retry-After
 *   capped at 30s. No retry storms.
 * - In-memory cache keyed by the search parameters (10-min TTL) +
 *   in-flight deduplication: identical concurrent searches share
 *   one request sequence.
 * - The user's AbortSignal aborts the whole sequence immediately
 *   (in-flight request, throttle gap, or Retry-After wait).
 * - If ANY category request fails (after its retry), the whole
 *   search fails with a typed EngineError ('places_unavailable'):
 *   a partial category set would silently bias the ranking, so no
 *   partial results are ever returned.
 *
 * Photon fair use (photon.komoot.io): the public instance is shared
 * infrastructure. Keep result counts capped, do not poll, and
 * self-host Photon for anything beyond light development use.
 * See ENGINE.md.
 */

/** Photon `include` categories per meeting category (group `osm`, main tag key.value). */
export const PHOTON_INCLUDE_CATEGORIES: Record<MeetingCategory, readonly string[]> = {
  cafe: ['osm.amenity.cafe'],
  restaurant: ['osm.amenity.restaurant'],
  bar: ['osm.amenity.bar', 'osm.amenity.pub'],
  park: ['osm.leisure.park'],
  library: ['osm.amenity.library'],
  coworking: ['osm.office.coworking'],
  fastFood: ['osm.amenity.fast_food'],
  mall: ['osm.shop.mall'],
  // Approximation: ALL stations (subway/light_rail indistinguishable — see header).
  metroStation: ['osm.railway.station'],
  railwayStation: ['osm.railway.station'],
  marketplace: ['osm.amenity.marketplace'],
  // Approximation: cafés/fast-food in the circle (cuisine unfilterable — see header).
  teaStall: ['osm.amenity.cafe', 'osm.amenity.fast_food'],
  any: [
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
  ],
};

export interface PhotonFetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    headers?: { get?: (name: string) => string | null };
    json: () => Promise<unknown>;
  }>;
}

export interface PhotonClientOptions {
  baseUrl: string;
  /** Per-request timeout (ms). Default 15s. */
  timeoutMs?: number;
  /** Minimum gap between request starts (ms). Default 1000ms. */
  minGapMs?: number;
  cacheTtlMs?: number;
  maxRetryDelayMs?: number;
  fetchImpl?: PhotonFetchLike;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_PHOTON_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_GAP_MS = 1000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;

const TIMEOUT_MESSAGE = 'Live place search timed out — try again later. No estimates shown.';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep that rejects promptly when `signal` aborts. Mirrors the helper in placesClient.ts. */
function sleepAbortable(ms: number, signal: AbortSignal | undefined, sleepFn: (ms: number) => Promise<void>): Promise<void> {
  if (ms <= 0) return Promise.resolve();
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

function formatCoord(n: number): string {
  return n.toFixed(5);
}

/**
 * Per-category result limit: the area limit split across the
 * category's include values, at least 3 per category so a
 * multi-category search (e.g. `any` with 11 includes) still gets a
 * usable handful of each kind. The orchestrator pre-filters to
 * maxCandidates before routing, so over-fetching here is trimmed
 * downstream, never silently ranked.
 */
export function photonPerCategoryLimit(limit: number, numCategories: number): number {
  return Math.max(3, Math.ceil(limit / Math.max(1, numCategories)));
}

/**
 * Build one Photon category-search URL. Photon bbox order is
 * minLon,minLat,maxLon,maxLat — i.e. west,south,east,north from
 * bboxForSearchArea() (whose fields are south=minLat, west=minLon,
 * north=maxLat, east=maxLon). `lat`/`lon` bias the ranking toward
 * the search centre; `lang=en` asks for English names where Photon
 * has them. No `q` parameter: category-only search, verified live.
 */
export function buildPhotonRequestUrl(
  baseUrl: string,
  area: SearchArea,
  includeCategory: string,
  perCategoryLimit: number,
): string {
  const bbox = bboxForSearchArea(area);
  const base = baseUrl.trim().replace(/\/+$/, '');
  const params = new URLSearchParams({
    include: includeCategory,
    bbox: `${formatCoord(bbox.west)},${formatCoord(bbox.south)},${formatCoord(bbox.east)},${formatCoord(bbox.north)}`,
    lat: formatCoord(area.centerLat),
    lon: formatCoord(area.centerLng),
    limit: String(perCategoryLimit),
    lang: 'en',
  });
  return `${base}/api/?${params.toString()}`;
}

/** Tags for a Photon include value, used as the label fallback when a feature lacks osm_key/osm_value. */
function tagsForIncludeCategory(includeCategory: string): Record<string, string> {
  const rest = includeCategory.startsWith('osm.') ? includeCategory.slice('osm.'.length) : includeCategory;
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return {};
  return { [rest.slice(0, dot)]: rest.slice(dot + 1) };
}

interface PhotonFeature {
  geometry?: { coordinates?: unknown };
  properties?: Record<string, unknown>;
}

/**
 * Photon osm_type is a single letter (N/W/R); accept the full words
 * too, defensively. Returns the OSM identity ('node/123') or null
 * when no valid identity can be formed.
 */
function osmIdFor(osmType: unknown, osmId: unknown): string | null {
  const kind =
    osmType === 'N' || osmType === 'node'
      ? 'node'
      : osmType === 'W' || osmType === 'way'
        ? 'way'
        : osmType === 'R' || osmType === 'relation'
          ? 'relation'
          : null;
  if (!kind) return null;
  if (typeof osmId === 'number' && Number.isFinite(osmId)) return `${kind}/${Math.trunc(osmId)}`;
  if (typeof osmId === 'string' && /^\d+$/.test(osmId.trim())) return `${kind}/${osmId.trim()}`;
  return null;
}

function featureCoords(feature: PhotonFeature): { lat: number; lng: number } | null {
  const coords = feature.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  // GeoJSON order: [longitude, latitude].
  const [lng, lat] = coords;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function addressFromProperties(props: Record<string, unknown>): string | undefined {
  const joined = [pickString(props.housenumber), pickString(props.street)].filter(Boolean).join(' ');
  const tailParts: string[] = [];
  for (const part of [pickString(props.suburb), pickString(props.district), pickString(props.city)]) {
    if (part && !tailParts.includes(part)) tailParts.push(part);
  }
  const address = [joined, tailParts.join(', ')].filter((p) => p.length > 0).join(', ');
  return address.length > 0 ? address : undefined;
}

export interface ParsedPhotonPlaces {
  places: CandidatePlace[];
  /** Features dropped for missing/invalid coords, missing name, or missing OSM identity. */
  dropped: number;
  total: number;
}

/**
 * Parse one Photon GeoJSON response. Drops features without finite
 * in-range coordinates, without a non-empty name, or without a
 * usable OSM identity (unnamed/unidentified objects cannot be
 * presented as meeting places). Never throws on malformed shapes —
 * unknown payloads parse to zero places.
 *
 * The category label comes from the feature's own osm_key/osm_value
 * via categoryLabelForTags; when those are absent, the requested
 * include category's tags are the fallback, so a place is never
 * labelled from nothing.
 */
export function parsePhotonResponse(payload: unknown, includeCategory: string): ParsedPhotonPlaces {
  if (typeof payload !== 'object' || payload === null) return { places: [], dropped: 0, total: 0 };
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features)) return { places: [], dropped: 0, total: 0 };
  const fallbackTags = tagsForIncludeCategory(includeCategory);
  const places: CandidatePlace[] = [];
  let dropped = 0;
  for (const raw of features) {
    if (typeof raw !== 'object' || raw === null) {
      dropped += 1;
      continue;
    }
    const feature = raw as PhotonFeature;
    const props = feature.properties;
    if (typeof props !== 'object' || props === null) {
      dropped += 1;
      continue;
    }
    const name = pickString(props.name);
    const osmId = osmIdFor(props.osm_type, props.osm_id);
    const coords = featureCoords(feature);
    if (!name || !osmId || !coords) {
      dropped += 1;
      continue;
    }
    const osmKey = pickString(props.osm_key);
    const osmValue = pickString(props.osm_value);
    const tags = osmKey && osmValue ? { [osmKey]: osmValue } : fallbackTags;
    places.push({
      osmId,
      name,
      category: categoryLabelForTags(tags),
      lat: coords.lat,
      lng: coords.lng,
      address: addressFromProperties(props),
      tags,
      source: 'photon',
    });
  }
  return { places, dropped, total: features.length };
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

export function createPhotonClient(options: PhotonClientOptions): PlacesClient {
  const fetchImpl: PhotonFetchLike =
    options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<PhotonFetchLike>);
  const now = options.now ?? (() => Date.now());
  const sleepFn = options.sleepFn ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PHOTON_TIMEOUT_MS;
  const minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  const cache = new Map<string, { result: PlacesSearchResult; fetchedAt: number }>();
  const inflight = new Map<string, Promise<PlacesSearchResult>>();
  let lastRequestStart = 0;

  function cacheKey(area: SearchArea, category: MeetingCategory, limit: number): string {
    return JSON.stringify({
      baseUrl,
      lat: formatCoord(area.centerLat),
      lng: formatCoord(area.centerLng),
      radiusKm: area.radiusKm,
      category,
      limit,
    });
  }

  /**
   * Enforce the minimum gap between request starts (mirrors the
   * OSRM client's throttle). The wait is abort-aware: cancelling
   * during the gap rejects immediately instead of stalling.
   */
  async function throttle(signal?: AbortSignal): Promise<void> {
    const waitMs = Math.max(0, lastRequestStart + minGapMs - now());
    await sleepAbortable(waitMs, signal, sleepFn);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    lastRequestStart = now();
  }

  /**
   * One include-category request, with the retry discipline: at most
   * one retry, only on 429/504, honouring Retry-After. Throws
   * EngineUnavailableError when the category is exhausted (the
   * caller fails the whole search — no partial category sets) and
   * rethrows AbortError when the caller aborted.
   */
  async function fetchCategory(
    area: SearchArea,
    includeCategory: string,
    perCategoryLimit: number,
    signal?: AbortSignal,
  ): Promise<ParsedPhotonPlaces> {
    const url = buildPhotonRequestUrl(baseUrl, area, includeCategory, perCategoryLimit);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await throttle(signal);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const onExternalAbort = () => controller.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        const response = await fetchImpl(url, { signal: controller.signal });
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
        return parsePhotonResponse(payload, includeCategory);
      } catch (err) {
        if (err instanceof EngineError) throw err;
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (signal?.aborted) throw err;
          throw new EngineUnavailableError('places', TIMEOUT_MESSAGE);
        }
        throw new EngineUnavailableError('places');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  /**
   * Run the category requests strictly sequentially. Any category
   * failure fails the whole search (see header). Results are
   * deduplicated across categories (first wins: an OSM object
   * matching two includes is one place, not two).
   */
  async function runSearch(area: SearchArea, category: MeetingCategory, limit: number, signal?: AbortSignal): Promise<PlacesSearchResult> {
    const includes = PHOTON_INCLUDE_CATEGORIES[category];
    const perCategoryLimit = photonPerCategoryLimit(limit, includes.length);
    const places: CandidatePlace[] = [];
    let dropped = 0;
    for (const includeCategory of includes) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const parsed = await fetchCategory(area, includeCategory, perCategoryLimit, signal);
      places.push(...parsed.places);
      dropped += parsed.dropped;
    }
    const deduped = deduplicatePlaces(places);
    return {
      places: deduped.places,
      dropped,
      duplicatesRemoved: deduped.duplicatesRemoved,
      endpoint: baseUrl,
    };
  }

  return {
    provider: 'photon',
    async search(area, category, limit, signal) {
      const key = cacheKey(area, category, limit);
      const entry = cache.get(key);
      if (entry && (cacheTtlMs <= 0 || now() - entry.fetchedAt <= cacheTtlMs)) {
        return entry.result;
      }
      const pending = inflight.get(key);
      if (pending) return shareInflight(pending, signal);
      const task = runSearch(area, category, limit, signal)
        .then((result) => {
          // The bbox request over-fetches the corners outside the
          // search circle; trim them here (before caching) so ranking
          // never sees a place outside the circle.
          const circled = filterPlacesToCircle(result.places, area);
          const filtered: PlacesSearchResult = {
            ...result,
            places: circled.places,
            dropped: result.dropped + circled.outsideCircle,
            outsideCircle: circled.outsideCircle,
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
      return task;
    },
  };
}

/**
 * Shared Photon client singleton (keyed by endpoint + timeout), so
 * the 10-minute cache survives across searches instead of being thrown
 * away with a fresh client per search. Mirrors the routing singleton
 * in src/map/routing.ts. Tests should use createPhotonClient directly.
 */
const sharedClients = new Map<string, PlacesClient>();

export function getSharedPhotonClient(options: PhotonClientOptions): PlacesClient {
  const key = `${options.baseUrl}|${options.timeoutMs ?? DEFAULT_PHOTON_TIMEOUT_MS}`;
  const existing = sharedClients.get(key);
  if (existing) return existing;
  const client = createPhotonClient(options);
  sharedClients.set(key, client);
  return client;
}
