import { describe, expect, it } from 'vitest';
import { isOsmId, validatePublishPlaces } from '../../supabase/functions/_shared/validation';

/**
 * Edge Function validation tests. supabase/functions/_shared/validation.ts
 * is pure TypeScript with no Deno APIs, so these run under Node/vitest.
 * The publish-results handler itself (Deno.serve + Supabase client) cannot
 * run here — Deno is not installed — and is covered by careful review +
 * the live test in TESTING.md §7/§8.
 */

describe('isOsmId', () => {
  it('accepts node/way/relation ids and rejects everything else', () => {
    expect(isOsmId('node/123')).toBe(true);
    expect(isOsmId('way/456')).toBe(true);
    expect(isOsmId('relation/789')).toBe(true);
    expect(isOsmId('mock/abc')).toBe(false);
    expect(isOsmId('node/abc')).toBe(false);
    expect(isOsmId('node/')).toBe(false);
    expect(isOsmId('NODE/123')).toBe(false);
    expect(isOsmId('node/12.5')).toBe(false);
    expect(isOsmId('')).toBe(false);
    expect(isOsmId(123)).toBe(false);
    expect(isOsmId(null)).toBe(false);
  });
});

function validPlace(overrides: Record<string, unknown> = {}) {
  return {
    osmId: 'node/1474258844',
    name: "Gloria Jean's",
    category: 'Café',
    lat: 12.9761,
    lng: 77.6412,
    address: '100 Feet Road, Indiranagar',
    ...overrides,
  };
}

describe('validatePublishPlaces', () => {
  it('accepts 1–5 valid places and normalizes them', () => {
    const { error, places } = validatePublishPlaces([validPlace()]);
    expect(error).toBeNull();
    expect(places).toEqual([
      {
        osmId: 'node/1474258844',
        name: "Gloria Jean's",
        category: 'Café',
        lat: 12.9761,
        lng: 77.6412,
        address: '100 Feet Road, Indiranagar',
      },
    ]);
    expect(validatePublishPlaces([validPlace(), validPlace({ osmId: 'way/2' })]).error).toBeNull();
  });

  it('normalizes a missing address to an empty string', () => {
    const place = validPlace();
    delete (place as Record<string, unknown>)['address'];
    const { error, places } = validatePublishPlaces([place]);
    expect(error).toBeNull();
    expect(places[0].address).toBe('');
  });

  it('rejects non-arrays, empty arrays, and more than 5 places', () => {
    expect(validatePublishPlaces(null).error).toMatch('array');
    expect(validatePublishPlaces('nope').error).toMatch('array');
    expect(validatePublishPlaces([]).error).toMatch('At least one');
    const six = Array.from({ length: 6 }, (_, i) => validPlace({ osmId: `node/${i + 1}` }));
    expect(validatePublishPlaces(six).error).toMatch('At most 5');
  });

  it('rejects bad OSM ids, duplicate ids, and non-object entries', () => {
    expect(validatePublishPlaces([validPlace({ osmId: 'mock/abc' })]).error).toMatch('valid OSM id');
    expect(validatePublishPlaces([validPlace({ osmId: 'node/x' })]).error).toMatch('valid OSM id');
    expect(validatePublishPlaces([validPlace(), validPlace()]).error).toMatch('twice');
    expect(validatePublishPlaces(['nope']).error).toMatch('object');
    expect(validatePublishPlaces([null]).error).toMatch('object');
  });

  it('rejects missing/oversized names and categories', () => {
    expect(validatePublishPlaces([validPlace({ name: '  ' })]).error).toMatch('name');
    expect(validatePublishPlaces([validPlace({ name: 'x'.repeat(201) })]).error).toMatch('200');
    expect(validatePublishPlaces([validPlace({ category: '' })]).error).toMatch('category');
    expect(validatePublishPlaces([validPlace({ category: 'x'.repeat(61) })]).error).toMatch('60');
  });

  it('accepts display-label categories (not enum keys) and rejects bad coordinates', () => {
    // CandidatePlace.category is a label from categoryLabelForTags
    // ('Café', 'Tea stall', ...), never a MeetingCategory enum key.
    expect(validatePublishPlaces([validPlace({ category: 'Tea stall' })]).error).toBeNull();
    expect(validatePublishPlaces([validPlace({ category: 'Place' })]).error).toBeNull();
    expect(validatePublishPlaces([validPlace({ lat: 91 })]).error).toMatch('Latitude');
    expect(validatePublishPlaces([validPlace({ lng: -181 })]).error).toMatch('Longitude');
    expect(validatePublishPlaces([validPlace({ lat: '12.9' })]).error).toMatch('Latitude');
    expect(validatePublishPlaces([validPlace({ lat: Number.NaN })]).error).toMatch('Latitude');
  });

  it('rejects oversized or non-string addresses', () => {
    expect(validatePublishPlaces([validPlace({ address: 'x'.repeat(501) })]).error).toMatch('500');
    expect(validatePublishPlaces([validPlace({ address: 42 })]).error).toMatch('string');
  });

  it('never accepts rating/price/open-now fields (they are dropped, not validated)', () => {
    // Extra fields are ignored by validation; the handler never reads
    // them, so a client cannot inject invented rating data.
    const { error, places } = validatePublishPlaces([
      validPlace({ rating: 5, price_level: 3, open_now: true }),
    ]);
    expect(error).toBeNull();
    expect('rating' in places[0]).toBe(false);
    expect('price_level' in places[0]).toBe(false);
    expect('open_now' in places[0]).toBe(false);
  });
});
