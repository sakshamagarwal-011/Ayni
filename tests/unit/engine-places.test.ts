import { describe, expect, it } from 'vitest';
import {
  CATEGORY_TAGS,
  MAX_OVERPASS_RESULTS,
  OVERPASS_TIMEOUT_SECONDS,
  bboxForSearchArea,
  buildOverpassQuery,
  categoryLabelForTags,
  deduplicatePlaces,
  filterPlacesToCircle,
  parseOverpassResponse,
} from '../../src/engine/places';
import type { CandidatePlace, SearchArea } from '../../src/engine/types';

const AREA: SearchArea = { centerLat: 12.9716, centerLng: 77.6412, radiusKm: 5, reason: 'test' };
// Bbox enclosing AREA's 5 km circle: (south, west, north, east).
const AREA_BBOX = '(12.92663,77.59506,13.01657,77.68734)';

describe('buildOverpassQuery', () => {
  it('builds node/way clauses with a bbox filter + timeout + center output, no relations, no around', () => {
    const ql = buildOverpassQuery(AREA, 'cafe', 30);
    expect(ql).toContain('[out:json][timeout:45]');
    // ["name"] keeps unnamed results out of the capped result set.
    expect(ql).toContain(`node["amenity"="cafe"]["name"]${AREA_BBOX};`);
    expect(ql).toContain(`way["amenity"="cafe"]["name"]${AREA_BBOX};`);
    expect(ql).not.toContain('relation');
    expect(ql).not.toContain('around');
    expect(ql).toContain('out center 30;');
  });

  it('derives the QL timeout from the caller timeout and clamps it', () => {
    expect(buildOverpassQuery(AREA, 'cafe', 30, 60)).toContain('[out:json][timeout:60]');
    expect(buildOverpassQuery(AREA, 'cafe', 30, 1)).toContain('[out:json][timeout:5]');
    expect(buildOverpassQuery(AREA, 'cafe', 30, 999)).toContain('[out:json][timeout:180]');
  });

  it('defaults the QL timeout to the 45s weak-mirror default', () => {
    expect(OVERPASS_TIMEOUT_SECONDS).toBe(45);
    expect(buildOverpassQuery(AREA, 'cafe', 30)).toContain('[out:json][timeout:45]');
  });

  it('includes every filter for bar (bar + pub) and any', () => {
    const bar = buildOverpassQuery(AREA, 'bar', 10);
    expect(bar).toContain('["amenity"="bar"]');
    expect(bar).toContain('["amenity"="pub"]');
    const any = buildOverpassQuery(AREA, 'any', 10);
    for (const filter of CATEGORY_TAGS.any) expect(any).toContain(filter);
  });

  it('covers the India-first categories with correct OSM tags, all included in any', () => {
    expect(CATEGORY_TAGS.mall).toEqual(['["shop"="mall"]']);
    expect(CATEGORY_TAGS.metroStation).toEqual([
      '["railway"="station"]["station"="subway"]',
      '["railway"="station"]["station"="light_rail"]',
    ]);
    expect(CATEGORY_TAGS.railwayStation).toEqual(['["railway"="station"]']);
    expect(CATEGORY_TAGS.marketplace).toEqual(['["amenity"="marketplace"]']);
    expect(CATEGORY_TAGS.teaStall).toEqual([
      '["amenity"="cafe"]["cuisine"="tea"]',
      '["amenity"="fast_food"]["cuisine"="tea"]',
    ]);
    // 'any' is the union of every category's filters.
    const union = new Set<string>();
    for (const [key, filters] of Object.entries(CATEGORY_TAGS)) {
      if (key === 'any') continue;
      for (const f of filters) union.add(f);
    }
    expect(new Set(CATEGORY_TAGS.any)).toEqual(union);
    expect(buildOverpassQuery(AREA, 'metroStation', 10)).toContain('["station"="subway"]');
    expect(buildOverpassQuery(AREA, 'teaStall', 10)).toContain('["cuisine"="tea"]');
  });

  it('clamps the result limit to [1, 50]', () => {
    expect(buildOverpassQuery(AREA, 'cafe', 999)).toContain(`out center ${MAX_OVERPASS_RESULTS};`);
    expect(buildOverpassQuery(AREA, 'cafe', 0)).toContain('out center 1;');
  });

  it('never emits relation clauses, even for the union category', () => {
    expect(buildOverpassQuery(AREA, 'any', 10)).not.toContain('relation');
  });

  it('sizes the bbox from the radius: a smaller radius shrinks the box', () => {
    const small = buildOverpassQuery({ ...AREA, radiusKm: 2 }, 'park', 10);
    expect(small).toContain('(12.95361,77.62274,12.98959,77.65966)');
    expect(small).not.toContain(AREA_BBOX);
  });
});

describe('bboxForSearchArea', () => {
  it('returns (south, west, north, east) enclosing the centre, symmetric in degrees', () => {
    const bbox = bboxForSearchArea(AREA);
    expect(bbox.south).toBeLessThan(AREA.centerLat);
    expect(bbox.north).toBeGreaterThan(AREA.centerLat);
    expect(bbox.west).toBeLessThan(AREA.centerLng);
    expect(bbox.east).toBeGreaterThan(AREA.centerLng);
    expect(AREA.centerLat - bbox.south).toBeCloseTo(bbox.north - AREA.centerLat, 9);
    expect(AREA.centerLng - bbox.west).toBeCloseTo(bbox.east - AREA.centerLng, 9);
    // Longitude degrees span wider than latitude degrees away from the equator.
    expect(bbox.east - bbox.west).toBeGreaterThan(bbox.north - bbox.south);
  });

  it('matches the exact formatted bbox used in the query', () => {
    const bbox = bboxForSearchArea(AREA);
    const formatted = `(${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)})`;
    expect(formatted).toBe(AREA_BBOX);
  });

  it('clamps to valid lat/lng ranges near the poles', () => {
    const bbox = bboxForSearchArea({ centerLat: 89.9, centerLng: 0, radiusKm: 25, reason: 'test' });
    expect(bbox.north).toBe(90);
    expect(bbox.south).toBeLessThan(89.9);
  });
});

describe('filterPlacesToCircle', () => {
  const mk = (name: string, lat: number, lng: number): CandidatePlace => ({
    osmId: `node/${name}`,
    name,
    category: 'Café',
    lat,
    lng,
    source: 'overpass',
  });

  it('keeps places inside the circle and drops bbox-corner places, counting them', () => {
    const bbox = bboxForSearchArea(AREA);
    const result = filterPlacesToCircle(
      [
        mk('Inside', 12.95, 77.64), // ~2.4 km from the centre
        mk('Corner', bbox.north, bbox.east), // bbox corner: ~7.1 km out
        mk('Other corner', bbox.south, bbox.west),
      ],
      AREA,
    );
    expect(result.places.map((p) => p.name)).toEqual(['Inside']);
    expect(result.outsideCircle).toBe(2);
  });

  it('keeps a place exactly on the circle boundary', () => {
    const bbox = bboxForSearchArea(AREA);
    // The north edge midpoint sits exactly on the circle.
    const result = filterPlacesToCircle([mk('Edge', bbox.north, AREA.centerLng)], AREA);
    expect(result.places).toHaveLength(1);
    expect(result.outsideCircle).toBe(0);
  });

  it('drops a place just outside the circle', () => {
    const bbox = bboxForSearchArea(AREA);
    const result = filterPlacesToCircle([mk('Outside', bbox.north + 0.001, AREA.centerLng)], AREA);
    expect(result.places).toHaveLength(0);
    expect(result.outsideCircle).toBe(1);
  });
});

describe('categoryLabelForTags', () => {
  it('labels the India-first categories', () => {
    expect(categoryLabelForTags({ shop: 'mall' })).toBe('Mall');
    expect(categoryLabelForTags({ railway: 'station', station: 'subway' })).toBe('Metro station');
    expect(categoryLabelForTags({ railway: 'station', station: 'light_rail' })).toBe('Metro station');
    expect(categoryLabelForTags({ railway: 'station' })).toBe('Railway station');
    expect(categoryLabelForTags({ amenity: 'marketplace' })).toBe('Marketplace');
    expect(categoryLabelForTags({ amenity: 'cafe', cuisine: 'tea' })).toBe('Tea stall');
    expect(categoryLabelForTags({ amenity: 'fast_food', cuisine: 'tea' })).toBe('Tea stall');
    // A plain café is not a tea stall.
    expect(categoryLabelForTags({ amenity: 'cafe' })).toBe('Café');
  });
});

describe('parseOverpassResponse', () => {
  it('parses nodes, ways (center), and relations (center)', () => {
    const payload = {
      elements: [
        { type: 'node', id: 1, lat: 12.97, lon: 77.64, tags: { name: 'Node Café', amenity: 'cafe' } },
        {
          type: 'way',
          id: 2,
          center: { lat: 12.96, lon: 77.63 },
          tags: { name: 'Way Bakery', amenity: 'cafe', 'addr:street': 'MG Road', 'addr:housenumber': '12' },
        },
        {
          type: 'relation',
          id: 3,
          center: { lat: 12.95, lon: 77.62 },
          tags: { name: 'Relation Park', leisure: 'park' },
        },
      ],
    };
    const parsed = parseOverpassResponse(payload);
    expect(parsed.total).toBe(3);
    expect(parsed.dropped).toBe(0);
    expect(parsed.places.map((p) => p.osmId)).toEqual(['node/1', 'way/2', 'relation/3']);
    expect(parsed.places[1].address).toBe('12 MG Road');
    expect(parsed.places[2].category).toBe('Park');
    expect(parsed.places[0].source).toBe('overpass');
  });

  it('drops unnamed, coordinate-less, and malformed elements with counts', () => {
    const payload = {
      elements: [
        { type: 'node', id: 1, lat: 12.97, lon: 77.64, tags: { amenity: 'cafe' } }, // no name
        { type: 'node', id: 2, tags: { name: 'No coords' } }, // no coords
        { type: 'way', id: 3, tags: { name: 'No center' } }, // no center
        { type: 'node', id: 4, lat: 91, lon: 77.64, tags: { name: 'Bad lat' } },
        { type: 'mystery', id: 5, lat: 12.97, lon: 77.64, tags: { name: 'Bad type' } },
        { type: 'node', id: 6, lat: 12.97, lon: 77.64, tags: { name: '  ' } }, // blank name
        { type: 'node', id: 7, lat: 12.97, lon: 77.64, tags: { name: 'Good Café', amenity: 'cafe' } },
      ],
    };
    const parsed = parseOverpassResponse(payload);
    expect(parsed.total).toBe(7);
    expect(parsed.places).toHaveLength(1);
    expect(parsed.places[0].name).toBe('Good Café');
    expect(parsed.dropped).toBe(6);
  });

  it('handles malformed payloads without throwing', () => {
    expect(parseOverpassResponse(null)).toEqual({ places: [], dropped: 0, total: 0 });
    expect(parseOverpassResponse({})).toEqual({ places: [], dropped: 0, total: 0 });
    expect(parseOverpassResponse({ elements: 'nope' })).toEqual({ places: [], dropped: 0, total: 0 });
    expect(parseOverpassResponse('text')).toEqual({ places: [], dropped: 0, total: 0 });
  });
});

describe('deduplicatePlaces', () => {
  it('dedups by osmId, first wins, order preserved', () => {
    const mk = (osmId: string, name: string): CandidatePlace => ({
      osmId,
      name,
      category: 'Café',
      lat: 12.97,
      lng: 77.64,
      source: 'overpass',
    });
    const result = deduplicatePlaces([mk('node/1', 'First'), mk('way/2', 'Second'), mk('node/1', 'Duplicate')]);
    expect(result.places.map((p) => p.name)).toEqual(['First', 'Second']);
    expect(result.duplicatesRemoved).toBe(1);
  });
});
