import { describe, expect, it } from 'vitest';
import { boundsForPoints, centreForPoints, fitPointsForSelection, isExpired, isExpiringSoon, straightLineGeometry } from '../../src/map/geo';
import type { MeetingSpot, Participant } from '../../src/types';

const INDIRANAGAR = { lat: 12.9716, lng: 77.6412 };
const KORAMANGALA = { lat: 12.9352, lng: 77.6245 };
const CP_DELHI = { lat: 28.634, lng: 77.2197 };
const MURADNAGAR = { lat: 28.8317, lng: 77.5104 };

function participant(id: string, location: { lat: number; lng: number } | null): Participant {
  return {
    id,
    roomId: 'room-1',
    authUid: null,
    displayName: id,
    avatarColor: '#000000',
    isHost: false,
    isReady: false,
    joinedAt: '2026-11-17T00:00:00.000Z',
    lastSeenAt: '2026-11-17T00:00:00.000Z',
    arrivedAt: null,
    location: location
      ? {
          id: `loc-${id}`,
          participantId: id,
          roomId: 'room-1',
          lat: location.lat,
          lng: location.lng,
          label: id,
          accuracyM: null,
          updatedAt: '2026-11-17T00:00:00.000Z',
          expiresAt: '2026-11-18T00:00:00.000Z',
        }
      : null,
  };
}

function spot(id: string, location: { lat: number; lng: number }): MeetingSpot {
  return {
    id,
    name: id,
    category: 'Café',
    address: '',
    location,
    rating: 0,
    priceLevel: 1,
    openNow: false,
    source: 'live',
    osmId: null,
    publishedRank: null,
  };
}

describe('boundsForPoints (Turf bbox)', () => {
  it('returns [west, south, east, north] covering all points', () => {
    expect(boundsForPoints([INDIRANAGAR, KORAMANGALA])).toEqual([77.6245, 12.9352, 77.6412, 12.9716]);
  });

  it('expands a single point into a small box around it', () => {
    const bounds = boundsForPoints([INDIRANAGAR]);
    expect(bounds).not.toBeNull();
    const [w, s, e, n] = bounds!;
    expect(w).toBeLessThan(INDIRANAGAR.lng);
    expect(e).toBeGreaterThan(INDIRANAGAR.lng);
    expect(s).toBeLessThan(INDIRANAGAR.lat);
    expect(n).toBeGreaterThan(INDIRANAGAR.lat);
    expect(e - w).toBeCloseTo(0.04, 6);
    expect(n - s).toBeCloseTo(0.04, 6);
  });

  it('expands degenerate bounds when all points are co-located', () => {
    const bounds = boundsForPoints([INDIRANAGAR, { ...INDIRANAGAR }, { ...INDIRANAGAR }]);
    expect(bounds).not.toBeNull();
    const [w, s, e, n] = bounds!;
    expect(e).toBeGreaterThan(w);
    expect(n).toBeGreaterThan(s);
  });

  it('expands bounds when points share only a latitude or longitude', () => {
    const sameLat = boundsForPoints([INDIRANAGAR, { lat: INDIRANAGAR.lat, lng: 77.7 }]);
    expect(sameLat![3]).toBeGreaterThan(sameLat![1]);
    const sameLng = boundsForPoints([INDIRANAGAR, { lat: 13.0, lng: INDIRANAGAR.lng }]);
    expect(sameLng![2]).toBeGreaterThan(sameLng![0]);
  });

  it('returns null for no points', () => {
    expect(boundsForPoints([])).toBeNull();
  });
});

describe('centreForPoints (Turf center)', () => {
  it('returns the midpoint for two symmetric points', () => {
    const c = centreForPoints([
      { lat: 0, lng: 0 },
      { lat: 2, lng: 2 },
    ]);
    expect(c).not.toBeNull();
    expect(c!.lat).toBeCloseTo(1, 6);
    expect(c!.lng).toBeCloseTo(1, 6);
  });

  it('returns the point itself for a single point', () => {
    const c = centreForPoints([INDIRANAGAR]);
    expect(c!.lat).toBeCloseTo(INDIRANAGAR.lat, 6);
    expect(c!.lng).toBeCloseTo(INDIRANAGAR.lng, 6);
  });

  it('returns null for no points', () => {
    expect(centreForPoints([])).toBeNull();
  });
});

describe('straightLineGeometry', () => {
  it('returns [lng, lat] pairs in GeoJSON order', () => {
    expect(straightLineGeometry(INDIRANAGAR, KORAMANGALA)).toEqual([
      [77.6412, 12.9716],
      [77.6245, 12.9352],
    ]);
  });
});

describe('location expiry', () => {
  const now = new Date('2026-11-17T12:00:00Z');

  it('isExpired is true at/past expiry, false before', () => {
    expect(isExpired({ expiresAt: '2026-11-17T11:59:59Z' }, now)).toBe(true);
    expect(isExpired({ expiresAt: '2026-11-17T12:00:00Z' }, now)).toBe(true);
    expect(isExpired({ expiresAt: '2026-11-17T12:00:01Z' }, now)).toBe(false);
  });

  it('isExpiringSoon is true only within the window and not yet expired', () => {
    expect(isExpiringSoon({ expiresAt: '2026-11-17T12:10:00Z' }, now)).toBe(true);
    expect(isExpiringSoon({ expiresAt: '2026-11-17T12:16:00Z' }, now)).toBe(false);
    expect(isExpiringSoon({ expiresAt: '2026-11-17T11:59:00Z' }, now)).toBe(false);
    expect(isExpiringSoon({ expiresAt: '2026-11-17T12:10:00Z' }, now, 5 * 60 * 1000)).toBe(false);
  });
});

describe('fitPointsForSelection', () => {
  const delhi = [participant('host', CP_DELHI), participant('guest', MURADNAGAR)];
  const spots = [spot('bengaluru-cafe', INDIRANAGAR), spot('sahibabad', { lat: 28.6743, lng: 77.3644 })];

  it('frames participants + ONLY the selected spot when the id matches', () => {
    const pts = fitPointsForSelection(delhi, spots, 'sahibabad');
    expect(pts).toEqual([CP_DELHI, MURADNAGAR, { lat: 28.6743, lng: 77.3644 }]);
    expect(pts).not.toContainEqual(INDIRANAGAR);
  });

  it('frames everything when nothing is selected', () => {
    expect(fitPointsForSelection(delhi, spots, null)).toEqual([CP_DELHI, MURADNAGAR, INDIRANAGAR, { lat: 28.6743, lng: 77.3644 }]);
    expect(fitPointsForSelection(delhi, spots, undefined)).toEqual([CP_DELHI, MURADNAGAR, INDIRANAGAR, { lat: 28.6743, lng: 77.3644 }]);
  });

  it('frames everything when the selected id matches no spot', () => {
    expect(fitPointsForSelection(delhi, spots, 'missing')).toEqual([CP_DELHI, MURADNAGAR, INDIRANAGAR, { lat: 28.6743, lng: 77.3644 }]);
  });

  it('skips participants without locations', () => {
    const pts = fitPointsForSelection(
      [participant('host', CP_DELHI), participant('noloc', null)],
      spots,
      'sahibabad',
    );
    expect(pts).toEqual([CP_DELHI, { lat: 28.6743, lng: 77.3644 }]);
  });

  it('returns empty for no participants, no spots, and no pin', () => {
    expect(fitPointsForSelection([], [], 'anything')).toEqual([]);
    expect(fitPointsForSelection([], [], null)).toEqual([]);
  });

  it('always includes the pin location when present', () => {
    const pin = { lat: 28.7, lng: 77.4 };
    expect(fitPointsForSelection(delhi, spots, 'sahibabad', pin)).toEqual([CP_DELHI, MURADNAGAR, { lat: 28.6743, lng: 77.3644 }, pin]);
    expect(fitPointsForSelection([], [], null, pin)).toEqual([pin]);
  });
});
