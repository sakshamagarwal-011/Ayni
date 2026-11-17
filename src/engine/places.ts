import type { CandidatePlace, MeetingCategory, SearchArea } from './types';

/**
 * Steps 3–4 (pure half) — OpenStreetMap place discovery via Overpass QL.
 *
 * The open-source replacement for a proprietary places API:
 * - Identity is the OSM type+id (e.g. 'node/123456'), which is what
 *   deduplication keys on — the equivalent of a Place ID.
 * - Query building and response parsing are pure and unit-tested with
 *   fixture JSON. The network call lives in placesClient.ts.
 *
 * Overpass QL notes:
 * - `nwr` is expanded to node/way/relation so ways/relations return a
 *   `center` (a single representative point) via `out center`.
 * - Timeout 25s matches the public overpass-api.de guidance for
 *   interactive queries. Result count is capped (see buildOverpassQuery).
 * - `around` takes metres, then latitude, longitude.
 */

export const OVERPASS_TIMEOUT_SECONDS = 25;
export const MAX_OVERPASS_RESULTS = 50;

/** OSM tag filters per meeting category. Each entry is one Overpass filter clause. */
export const CATEGORY_TAGS: Record<MeetingCategory, string[]> = {
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

export function categoryLabelForTags(tags: Record<string, string>): string {
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

function formatCoord(n: number): string {
  return n.toFixed(5);
}

/** Build an Overpass QL query for one search area + category. `limit` is clamped to [1, 50]. */
export function buildOverpassQuery(
  area: SearchArea,
  category: MeetingCategory,
  limit: number,
  timeoutSeconds: number = OVERPASS_TIMEOUT_SECONDS,
): string {
  const capped = Math.min(MAX_OVERPASS_RESULTS, Math.max(1, Math.floor(limit)));
  const radiusM = Math.round(area.radiusKm * 1000);
  const filters = CATEGORY_TAGS[category];
  const clauses: string[] = [];
  const qlTimeout = Math.min(180, Math.max(5, Math.floor(timeoutSeconds)));
  for (const filter of filters) {
    for (const kind of ['node', 'way', 'relation'] as const) {
      // ["name"] filters unnamed elements server-side: without it the
      // result cap is consumed by unusable unnamed objects that the
      // parser then drops (crowding out named places).
      clauses.push(`  ${kind}${filter}["name"](around:${radiusM},${formatCoord(area.centerLat)},${formatCoord(area.centerLng)});`);
    }
  }
  return (
    `[out:json][timeout:${qlTimeout}];\n` +
    `(\n${clauses.join('\n')}\n);\n` +
    `out center ${capped};`
  );
}

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

export interface ParsedPlaces {
  places: CandidatePlace[];
  /** Elements dropped for missing/invalid coords or missing name. */
  dropped: number;
  total: number;
}

/**
 * Parse an Overpass JSON response. Drops elements without finite
 * coordinates or without a non-empty name (unnamed OSM objects cannot
 * be presented as meeting places). Never throws on malformed JSON
 * shapes — unknown payloads parse to zero places with a dropped count.
 */
export function parseOverpassResponse(payload: unknown): ParsedPlaces {
  if (typeof payload !== 'object' || payload === null) return { places: [], dropped: 0, total: 0 };
  const elements = (payload as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return { places: [], dropped: 0, total: 0 };
  const places: CandidatePlace[] = [];
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
      tags,
      source: 'overpass',
    });
  }
  return { places, dropped, total: elements.length };
}

export interface DeduplicatedPlaces {
  places: CandidatePlace[];
  duplicatesRemoved: number;
}

/** Deduplicate by OSM id (first occurrence wins). Order is preserved. */
export function deduplicatePlaces(places: CandidatePlace[]): DeduplicatedPlaces {
  const seen = new Set<string>();
  const out: CandidatePlace[] = [];
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
