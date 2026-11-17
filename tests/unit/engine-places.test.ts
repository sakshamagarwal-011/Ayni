import { describe, expect, it } from 'vitest';
import {
  CATEGORY_TAGS,
  MAX_OVERPASS_RESULTS,
  buildOverpassQuery,
  categoryLabelForTags,
  deduplicatePlaces,
  parseOverpassResponse,
} from '../../src/engine/places';
import type { CandidatePlace, SearchArea } from '../../src/engine/types';

const AREA: SearchArea = { centerLat: 12.9716, centerLng: 77.6412, radiusKm: 5, reason: 'test' };

describe('buildOverpassQuery', () => {
  it('builds node/way/relation clauses with around + timeout + center output', () => {
    const ql = buildOverpassQuery(AREA, 'cafe', 30);
    expect(ql).toContain('[out:json][timeout:25]');
    // ["name"] keeps unnamed results out of the capped result set.
    expect(ql).toContain('node["amenity"="cafe"]["name"](around:5000,12.97160,77.64120);');
    expect(ql).toContain('way["amenity"="cafe"]["name"](around:5000,12.97160,77.64120);');
    expect(ql).toContain('relation["amenity"="cafe"]["name"](around:5000,12.97160,77.64120);');
    expect(ql).toContain('out center 30;');
  });

  it('derives the QL timeout from the caller timeout and clamps it', () => {
    expect(buildOverpassQuery(AREA, 'cafe', 30, 60)).toContain('[out:json][timeout:60]');
    expect(buildOverpassQuery(AREA, 'cafe', 30, 1)).toContain('[out:json][timeout:5]');
    expect(buildOverpassQuery(AREA, 'cafe', 30, 999)).toContain('[out:json][timeout:180]');
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

  it('converts radius to metres', () => {
    expect(buildOverpassQuery({ ...AREA, radiusKm: 2.5 }, 'park', 10)).toContain('around:2500,');
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
