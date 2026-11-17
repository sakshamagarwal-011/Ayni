// places-search — server-side Overpass place search (Supabase Edge Function).
//
// WHY THIS EXISTS: browsers on cloud/datacenter networks cannot query
// Overpass directly. Live testing (2026-11-17) proved the main public
// instance rejects such networks with HTTP 406, and the small community
// mirrors time out server-side even on light bbox queries. Supabase,
// however, is reachable from every network the app runs on. So the
// browser talks only to Supabase, and this function queries Overpass
// server-side, where the request comes from Supabase's network.
//
// Auth: the platform JWT check stays ON (default verify_jwt = true).
// A valid user JWT is required (401 otherwise). This function needs NO
// service-role key and NO database access — it only fetches a public
// API, so it never calls getServiceClient.
//
// Abuse prevention: the client NEVER sends raw Overpass QL. The body
// carries structured search parameters only, and the function builds
// the query itself from a fixed allow-list of categories, with clamped
// radius/limit. There is no way to make this function run an arbitrary
// Overpass query.
//
// MIRROR WARNING: the query builder, category tags, bbox math, label
// logic, haversine, and response parsing below DUPLICATE the client
// code in src/engine/places.ts (Deno cannot import the Vite bundle).
// The two copies MUST stay in sync — change one, change the other.
// Each mirrored block is marked with a MIRROR comment naming its
// counterpart. See ENGINE.md ("Places proxy") for the contract.
import { getUserIdFromRequest, readJsonBody } from '../_shared/auth.ts';
import { handleOptions, jsonError, jsonResponse } from '../_shared/cors.ts';

/** Overpass endpoints, tried in order, strictly sequential. */
const OVERPASS_ENDPOINTS: readonly string[] = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Per-endpoint fetch timeout (ms) and Overpass QL timeout (seconds). Kept in step: the server must never out-wait the fetch. */
const ENDPOINT_TIMEOUT_MS = 20_000;
const QL_TIMEOUT_SECONDS = 20;
/** Max Retry-After honour delay (ms). Mirrors the browser client's cap. */
const MAX_RETRY_DELAY_MS = 30_000;
const EARTH_RADIUS_M = 6_371_000;

// ---------------------------------------------------------------------------
// Mirrored from src/engine/places.ts (MIRROR: CATEGORY_TAGS). Keep in sync.
// ---------------------------------------------------------------------------

type MeetingCategory =
  | 'cafe'
  | 'restaurant'
  | 'bar'
  | 'park'
  | 'library'
  | 'coworking'
  | 'fastFood'
  | 'mall'
  | 'metroStation'
  | 'railwayStation'
  | 'marketplace'
  | 'teaStall'
  | 'any';

const MEETING_CATEGORIES: readonly MeetingCategory[] = [
  'cafe',
  'restaurant',
  'bar',
  'park',
  'library',
  'coworking',
  'fastFood',
  'mall',
  'metroStation',
  'railwayStation',
  'marketplace',
  'teaStall',
  'any',
];

/** OSM tag filters per meeting category. Each entry is one Overpass filter clause. */
const CATEGORY_TAGS: Record<MeetingCategory, string[]> = {
  cafe: ['["amenity"="cafe"]'],
  restaurant: ['["amenity"="restaurant"]'],
  bar: ['["amenity"="bar"]', '["amenity"="pub"]'],
  park: ['["leisure"="park"]'],
  library: ['["amenity"="library"]'],
  coworking: ['["office"="coworking"]'],
  fastFood: ['["amenity"="fast_food"]'],
  mall: ['["shop"="mall"]'],
  // Metro stations are railway stations with a subway/light-rail
  // station tag. railwayStation below matches ALL stations (including
  // metro ones) — overlap is intentional, like bar including pubs.
  metroStation: ['["railway"="station"]["station"="subway"]', '["railway"="station"]["station"="light_rail"]'],
  railwayStation: ['["railway"="station"]'],
  marketplace: ['["amenity"="marketplace"]'],
  // Tea stalls are cafes/fast-food places whose cuisine is tea.
  teaStall: ['["amenity"="cafe"]["cuisine"="tea"]', '["amenity"="fast_food"]["cuisine"="tea"]'],
  any: [
    '["amenity"="cafe"]',
    '["amenity"="restaurant"]',
    '["amenity"="bar"]',
    '["amenity"="pub"]',
    '["amenity"="fast_food"]',
    '["leisure"="park"]',
    '["amenity"="library"]',
    '["office"="coworking"]',
    '["shop"="mall"]',
    '["railway"="station"]["station"="subway"]',
    '["railway"="station"]["station"="light_rail"]',
    '["railway"="station"]',
    '["amenity"="marketplace"]',
    '["amenity"="cafe"]["cuisine"="tea"]',
    '["amenity"="fast_food"]["cuisine"="tea"]',
  ],
};

// MIRROR: categoryLabelForTags in src/engine/places.ts. Keep in sync.
function categoryLabelForTags(tags: Record<string, string>): string {
  const amenity = tags.amenity;
  const leisure = tags.leisure;
  const office = tags.office;
  const shop = tags.shop;
  const railway = tags.railway;
  const station = tags.station;
  const cuisine = tags.cuisine;
  // Tea stalls first: a cafe/fast-food place with cuisine=tea is a
  // tea stall, not a generic café.
  if ((amenity === 'cafe' || amenity === 'fast_food') && cuisine === 'tea') return 'Tea stall';
  if (amenity === 'cafe') return 'Café';
  if (amenity === 'restaurant') return 'Restaurant';
  if (amenity === 'bar') return 'Bar';
  if (amenity === 'pub') return 'Pub';
  if (amenity === 'fast_food') return 'Fast food';
  if (amenity === 'library') return 'Library';
  if (amenity === 'marketplace') return 'Marketplace';
  if (leisure === 'park') return 'Park';
  if (office === 'coworking') return 'Coworking';
  if (shop === 'mall') return 'Mall';
  if (railway === 'station' && (station === 'subway' || station === 'light_rail')) return 'Metro station';
  if (railway === 'station') return 'Railway station';
  if (amenity) return amenity.replace(/_/g, ' ');
  if (leisure) return leisure.replace(/_/g, ' ');
  if (office) return office.replace(/_/g, ' ');
  if (shop) return shop.replace(/_/g, ' ');
  if (railway) return railway.replace(/_/g, ' ');
  return 'Place';
}

// MIRROR: haversineDistanceM in src/lib/distance.ts (via src/engine/places.ts
// filterPlacesToCircle). Geometry only — never a travel time. Keep in sync.
function haversineDistanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// MIRROR: bboxForSearchArea in src/engine/places.ts. Keep in sync.
// Overpass bounding-box filter order: (south, west, north, east).
function bboxForSearchArea(centerLat: number, centerLng: number, radiusKm: number): {
  south: number;
  west: number;
  north: number;
  east: number;
} {
  const radiusM = radiusKm * 1000;
  const latDeltaDeg = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.max(Math.cos((centerLat * Math.PI) / 180), 1e-9);
  const lngDeltaDeg = latDeltaDeg / cosLat;
  return {
    south: Math.max(-90, centerLat - latDeltaDeg),
    west: Math.max(-180, centerLng - lngDeltaDeg),
    north: Math.min(90, centerLat + latDeltaDeg),
    east: Math.min(180, centerLng + lngDeltaDeg),
  };
}

function formatCoord(n: number): string {
  return n.toFixed(5);
}

// MIRROR: buildOverpassQuery in src/engine/places.ts. Keep in sync.
// Node+way only, ["name"] filter, bbox filter, `out center <limit>`.
// Relations and `around` are deliberately NOT used: live testing
// (2026-11-17) proved that shape times out server-side on weak mirrors.
function buildOverpassQuery(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
  category: MeetingCategory,
  limit: number,
): string {
  const capped = Math.min(50, Math.max(1, Math.floor(limit)));
  const bbox = bboxForSearchArea(centerLat, centerLng, radiusKm);
  const bboxFilter = `(${formatCoord(bbox.south)},${formatCoord(bbox.west)},${formatCoord(bbox.north)},${formatCoord(bbox.east)})`;
  const filters = CATEGORY_TAGS[category];
  const clauses: string[] = [];
  for (const filter of filters) {
    for (const kind of ['node', 'way'] as const) {
      clauses.push(`  ${kind}${filter}["name"]${bboxFilter};`);
    }
  }
  return `[out:json][timeout:${QL_TIMEOUT_SECONDS}];\n(\n${clauses.join('\n')}\n);\nout center ${capped};`;
}

// ---------------------------------------------------------------------------
// Response parsing (MIRROR: parseOverpassResponse + deduplicatePlaces in
// src/engine/places.ts). Same drop rules, same dedup key. Keep in sync.
// ---------------------------------------------------------------------------

interface OverpassElement {
  type?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  center?: { lat?: unknown; lon?: unknown };
  tags?: Record<string, unknown>;
}

function elementCoords(el: OverpassElement): { lat: number; lng: number } | null {
  if (el.type === 'node') {
    if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lng: el.lon };
    return null;
  }
  const center = el.center;
  if (center && typeof center.lat === 'number' && typeof center.lon === 'number') {
    return { lat: center.lat, lng: center.lon };
  }
  return null;
}

function stringTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tags) return out;
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function addressFromTags(tags: Record<string, string>): string | undefined {
  const joined = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const tail = [tags['addr:suburb'], tags['addr:city']].filter(Boolean).join(', ');
  const address = [joined, tail].filter((p) => p.length > 0).join(', ');
  return address.length > 0 ? address : undefined;
}

interface ProxyPlace {
  osmId: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  address?: string;
}

/**
 * Parse an Overpass JSON response. Drops elements without finite
 * coordinates, with out-of-range coordinates, or without a non-empty
 * name. Never throws on malformed shapes — unknown payloads parse to
 * zero places with a dropped count.
 */
function parseOverpassResponse(payload: unknown): { places: ProxyPlace[]; dropped: number } {
  if (typeof payload !== 'object' || payload === null) return { places: [], dropped: 0 };
  const elements = (payload as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return { places: [], dropped: 0 };
  const places: ProxyPlace[] = [];
  let dropped = 0;
  for (const raw of elements) {
    const el = raw as OverpassElement;
    const type = el.type;
    const id = el.id;
    if (type !== 'node' && type !== 'way' && type !== 'relation') {
      dropped += 1;
      continue;
    }
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      dropped += 1;
      continue;
    }
    const coords = elementCoords(el);
    const tags = stringTags(el.tags);
    const name = (tags.name ?? '').trim();
    if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
      dropped += 1;
      continue;
    }
    if (coords.lat < -90 || coords.lat > 90 || coords.lng < -180 || coords.lng > 180) {
      dropped += 1;
      continue;
    }
    if (name.length === 0) {
      dropped += 1;
      continue;
    }
    places.push({
      osmId: `${type}/${id}`,
      name,
      category: categoryLabelForTags(tags),
      lat: coords.lat,
      lng: coords.lng,
      address: addressFromTags(tags),
    });
  }
  return { places, dropped };
}

/** Deduplicate by OSM id (first occurrence wins). Order is preserved. */
function deduplicatePlaces(places: ProxyPlace[]): { places: ProxyPlace[]; duplicatesRemoved: number } {
  const seen = new Set<string>();
  const out: ProxyPlace[] = [];
  let duplicatesRemoved = 0;
  for (const place of places) {
    if (seen.has(place.osmId)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(place.osmId);
    out.push(place);
  }
  return { places: out, duplicatesRemoved };
}

// ---------------------------------------------------------------------------
// Upstream fetch: sequential endpoint fallback, one retry on 429/504.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response): number {
  const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
  if (Number.isFinite(retryAfter)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAfter * 1000));
  return 1000;
}

/** True when an Overpass JSON payload reports a timed-out query with no elements at all. */
function isTimeoutRemarkWithNoElements(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const remark = (payload as { remark?: unknown }).remark;
  const elements = (payload as { elements?: unknown }).elements;
  const hasElements = Array.isArray(elements) && elements.length > 0;
  return typeof remark === 'string' && /timed out/i.test(remark) && !hasElements;
}

/**
 * Fetch one endpoint. Returns the parsed payload, or null when this
 * endpoint is exhausted (the caller moves to the next endpoint).
 * At most one retry, only on 429/504, honouring Retry-After.
 */
async function fetchFromEndpoint(endpoint: string, query: string): Promise<unknown | null> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status === 504;
        if (retryable && attempt === 1) {
          await sleep(retryDelayMs(response));
          continue;
        }
        return null;
      }
      const payload = (await response.json()) as unknown;
      // A server-side query timeout arrives as HTTP 200 with a
      // "Query timed out" remark and ZERO elements (observed on the
      // weak mirrors, 2026-11-17). That is an endpoint failure, not a
      // successful empty search: fall through to the next endpoint.
      // A remark WITH elements is still a usable result — keep it.
      if (isTimeoutRemarkWithNoElements(payload)) return null;
      return payload;
    } catch {
      // Network error, timeout, or invalid JSON: this endpoint is done.
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

interface PlacesSearchBody {
  centerLat?: unknown;
  centerLng?: unknown;
  radiusKm?: unknown;
  category?: unknown;
  limit?: unknown;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonError('Method not allowed.', 405);

  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return jsonError('Unauthorized.', 401);

    const body = await readJsonBody<PlacesSearchBody>(req);
    if (!body) return jsonError('Invalid JSON body.', 400);

    // Strict validation. Lat/lng/category must be valid; radius/limit
    // are clamped into their allowed ranges.
    if (!isFiniteNumber(body.centerLat) || body.centerLat < -90 || body.centerLat > 90) {
      return jsonError('centerLat must be a number between -90 and 90.', 400);
    }
    if (!isFiniteNumber(body.centerLng) || body.centerLng < -180 || body.centerLng > 180) {
      return jsonError('centerLng must be a number between -180 and 180.', 400);
    }
    if (!isFiniteNumber(body.radiusKm)) {
      return jsonError('radiusKm must be a number.', 400);
    }
    if (typeof body.category !== 'string' || !(MEETING_CATEGORIES as readonly string[]).includes(body.category)) {
      return jsonError('category must be a valid meeting category.', 400);
    }
    if (!isFiniteNumber(body.limit)) {
      return jsonError('limit must be a number.', 400);
    }
    const centerLat = body.centerLat;
    const centerLng = body.centerLng;
    const radiusKm = clamp(body.radiusKm, 0.5, 25);
    const category = body.category as MeetingCategory;
    const limit = clamp(Math.floor(body.limit), 1, 50);

    const query = buildOverpassQuery(centerLat, centerLng, radiusKm, category, limit);

    // Sequential endpoint fallback: never in parallel, no retry storms.
    let payload: unknown | null = null;
    let endpoint = '';
    for (const candidate of OVERPASS_ENDPOINTS) {
      const result = await fetchFromEndpoint(candidate, query);
      if (result !== null) {
        payload = result;
        endpoint = candidate;
        break;
      }
    }
    if (payload === null) {
      // Generic upstream failure: never leak upstream bodies/statuses.
      return jsonResponse({ error: 'places_unavailable' }, 502);
    }

    const parsed = parseOverpassResponse(payload);
    const deduped = deduplicatePlaces(parsed.places);

    // The bbox query over-fetches the corners outside the search
    // circle; trim them here (haversine geometry only) so callers
    // never rank a place outside the circle. The client re-applies
    // the same filter as defense in depth.
    const radiusM = radiusKm * 1000;
    const places: ProxyPlace[] = [];
    let outsideCircle = 0;
    for (const place of deduped.places) {
      if (haversineDistanceM(centerLat, centerLng, place.lat, place.lng) <= radiusM) {
        places.push(place);
      } else {
        outsideCircle += 1;
      }
    }

    return jsonResponse({
      places,
      dropped: parsed.dropped,
      duplicatesRemoved: deduped.duplicatesRemoved,
      outsideCircle,
      endpoint,
    });
  } catch {
    return jsonError('Internal error.', 500);
  }
});
