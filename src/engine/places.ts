import { EARTH_RADIUS_M, haversineDistanceM } from '../lib/distance';
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
 * - `nwr` is expanded to node/way (relations are not queried: they
 *   almost never represent the POI categories searched here, and
 *   asking for them makes weak mirror servers time out). Ways return
 *   a `center` (a single representative point) via `out center`.
 * - Queries use a bounding-box filter, NOT `around`: live testing
 *   (2026-11-17) proved the `around` + relation shape times out
 *   server-side on the small public mirrors, while a bbox query is
 *   far cheaper for them. A bbox covers corner areas outside the
 *   search circle, so fetched places are trimmed back to the circle
 *   client-side (filterPlacesToCircle, haversine geometry only).
 * - Timeout 45s: weak mirrors need more patience than the 25s the
 *   public overpass-api.de guidance suggests for interactive queries.
 *   Result count is capped (see buildOverpassQuery).
 */

export const OVERPASS_TIMEOUT_SECONDS = 45;
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

/** Overpass bounding-box filter order: (south, west, north, east). */
export interface SearchAreaBbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Bounding box enclosing a search circle, via destination math on the
 * same earth radius the haversine helper uses — so the box always
 * contains the whole circle (edge midpoints sit exactly on the
 * circle). Coordinates are clamped to valid lat/lng ranges.
 * Antimeridian wrap is not handled (India-first scope).
 */
export function bboxForSearchArea(area: SearchArea): SearchAreaBbox {
  const radiusM = area.radiusKm * 1000;
  const latDeltaDeg = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.max(Math.cos((area.centerLat * Math.PI) / 180), 1e-9);
  const lngDeltaDeg = latDeltaDeg / cosLat;
  return {
    south: Math.max(-90, area.centerLat - latDeltaDeg),
    west: Math.max(-180, area.centerLng - lngDeltaDeg),
    north: Math.min(90, area.centerLat + latDeltaDeg),
    east: Math.min(180, area.centerLng + lngDeltaDeg),
  };
}

/** Build an Overpass QL query for one search area + category. `limit` is clamped to [1, 50]. */
export function buildOverpassQuery(
  area: SearchArea,
  category: MeetingCategory,
  limit: number,
  timeoutSeconds: number = OVERPASS_TIMEOUT_SECONDS,
): string {
  const capped = Math.min(MAX_OVERPASS_RESULTS, Math.max(1, Math.floor(limit)));
  const bbox = bboxForSearchArea(area);
  const bboxFilter = `(${formatCoord(bbox.south)},${formatCoord(bbox.west)},${formatCoord(bbox.north)},${formatCoord(bbox.east)})`;
  const filters = CATEGORY_TAGS[category];
  const clauses: string[] = [];
  const qlTimeout = Math.min(180, Math.max(5, Math.floor(timeoutSeconds)));
  for (const filter of filters) {
    for (const kind of ['node', 'way'] as const) {
      // ["name"] filters unnamed elements server-side: without it the
      // result cap is consumed by unusable unnamed objects that the
      // parser then drops (crowding out named places).
      clauses.push(`  ${kind}${filter}["name"]${bboxFilter};`);
    }
  }
  return (
    `[out:json][timeout:${qlTimeout}];\n` +
    `(\n${clauses.join('\n')}\n);\n` +
    `out center ${capped};`
  );
}

export interface CircleFilteredPlaces {
  places: CandidatePlace[];
  /** Places fetched inside the bbox but outside the search circle. */
  outsideCircle: number;
}

/**
 * Keep only places within the search circle. The Overpass query uses a
 * bounding box (cheaper for weak servers than `around`), so the bbox
 * corners lie outside the circle and must be trimmed here — ranking
 * must never see a place outside the circle. Haversine is used ONLY
 * for this geometry check, never as a travel time. Places exactly on
 * the circle boundary are kept.
 */
export function filterPlacesToCircle(places: CandidatePlace[], area: SearchArea): CircleFilteredPlaces {
  const center = { lat: area.centerLat, lng: area.centerLng };
  const radiusM = area.radiusKm * 1000;
  const kept: CandidatePlace[] = [];
  let outsideCircle = 0;
  for (const place of places) {
    if (haversineDistanceM(center, { lat: place.lat, lng: place.lng }) <= radiusM) {
      kept.push(place);
    } else {
      outsideCircle += 1;
    }
  }
  return { places: kept, outsideCircle };
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
