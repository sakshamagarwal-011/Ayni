import { describe, expect, it } from 'vitest';
import { generateSearchAreas, spreadDiagonalKm } from '../../src/engine/searchAreas';
import type { ParticipantOrigin } from '../../src/engine/types';

function origin(lat: number, lng: number, id = 'p1', name = 'A'): ParticipantOrigin {
  return {
    participantId: id,
    displayName: name,
    lat,
    lng,
    mode: 'car',
    required: true,
    locationUpdatedAt: '2026-11-17T11:30:00.000Z',
    locationExpiresAt: '2026-11-17T14:00:00.000Z',
    consentGiven: true,
  };
}

describe('generateSearchAreas', () => {
  it('returns no areas for no origins', () => {
    expect(generateSearchAreas([])).toEqual([]);
  });

  it('returns one 2 km floor circle for a single origin', () => {
    const areas = generateSearchAreas([origin(12.9716, 77.6412)]);
    expect(areas).toHaveLength(1);
    expect(areas[0].radiusKm).toBe(2);
    expect(areas[0].centerLat).toBeCloseTo(12.9716, 4);
    expect(areas[0].centerLng).toBeCloseTo(77.6412, 4);
  });

  it('returns one 2 km circle for co-located origins', () => {
    const areas = generateSearchAreas([
      origin(12.9716, 77.6412, 'p1'),
      origin(12.9716, 77.6412, 'p2'),
      origin(12.9716, 77.6412, 'p3'),
    ]);
    expect(areas).toHaveLength(1);
    expect(areas[0].radiusKm).toBe(2);
  });

  it('sizes the circle from the median distance + 1 km buffer for a normal group', () => {
    // Bengaluru friends: Indiranagar, Koramangala, HSR, Whitefield.
    const areas = generateSearchAreas([
      origin(12.9716, 77.6412, 'p1'),
      origin(12.9352, 77.6245, 'p2'),
      origin(12.9116, 77.6474, 'p3'),
      origin(12.9698, 77.75, 'p4'),
    ]);
    expect(areas).toHaveLength(1);
    // Median distance from the bbox centre is a few km; +1 km buffer, within [2, 25].
    expect(areas[0].radiusKm).toBeGreaterThan(2);
    expect(areas[0].radiusKm).toBeLessThanOrEqual(25);
    expect(areas[0].centerLat).toBeGreaterThan(12.91);
    expect(areas[0].centerLat).toBeLessThan(12.98);
  });

  it('caps the radius at 25 km for very spread origins', () => {
    const areas = generateSearchAreas([
      origin(12.9716, 77.6412, 'p1'),
      origin(13.5, 78.5, 'p2'),
      origin(12.3, 76.9, 'p3'),
    ]);
    expect(areas[0].radiusKm).toBeLessThanOrEqual(25);
  });

  it('adds two extra areas for a >50 km spread (3 total, deterministic)', () => {
    const origins = [
      origin(12.9716, 77.6412, 'p1', 'Bengaluru'),
      origin(13.0827, 80.2707, 'p2', 'Chennai'),
      origin(12.2958, 76.6394, 'p3', 'Mysuru'),
    ];
    expect(spreadDiagonalKm(origins)).toBeGreaterThan(50);
    const areas = generateSearchAreas(origins);
    expect(areas).toHaveLength(3);
    expect(areas[1].radiusKm).toBe(5);
    expect(areas[2].radiusKm).toBe(5);
    // Extra areas centre on the two most distant origins (Chennai + Mysuru).
    const centres = areas.slice(1).map((a) => `${a.centerLat},${a.centerLng}`);
    expect(centres.join('|')).toContain('13.0827');
    expect(centres.join('|')).toContain('12.2958');
    // Deterministic: same input, same output.
    expect(generateSearchAreas(origins)).toEqual(areas);
  });
});
