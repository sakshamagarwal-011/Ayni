import { describe, expect, it } from 'vitest';
import {
  buildAllRouteEstimates,
  buildRouteEstimate,
  estimateDurationMin,
  haversineDistanceM,
} from '../../src/lib/distance';
import { MOCK_FRIENDS, MOCK_SPOTS } from '../../src/data/mockData';
import type { Participant } from '../../src/types';

const INDIRANAGAR = { lat: 12.9716, lng: 77.6412 };
const KORAMANGALA = { lat: 12.9352, lng: 77.6245 };

function participantWithLocation(lat: number, lng: number): Participant {
  return {
    id: 'p-1',
    roomId: 'room-1',
    authUid: null,
    displayName: 'Test',
    avatarColor: '#3B82F6',
    isHost: true,
    isReady: false,
    arrivedAt: null,
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    location: {
      id: 'loc-1',
      participantId: 'p-1',
      roomId: 'room-1',
      lat,
      lng,
      label: 'Test',
      accuracyM: 20,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  };
}

describe('haversine distance', () => {
  it('returns 0 for identical points', () => {
    expect(haversineDistanceM(INDIRANAGAR, INDIRANAGAR)).toBe(0);
  });

  it('is symmetric and in a sane range for Indiranagar <-> Koramangala (~4.4 km)', () => {
    const a = haversineDistanceM(INDIRANAGAR, KORAMANGALA);
    const b = haversineDistanceM(KORAMANGALA, INDIRANAGAR);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(4000);
    expect(a).toBeLessThan(5000);
  });

  it('is deterministic', () => {
    expect(haversineDistanceM(INDIRANAGAR, KORAMANGALA)).toBe(haversineDistanceM(INDIRANAGAR, KORAMANGALA));
  });
});

describe('route estimates', () => {
  it('walk is slower than car for the same distance', () => {
    expect(estimateDurationMin(5000, 'walk')).toBeGreaterThan(estimateDurationMin(5000, 'car'));
    expect(estimateDurationMin(5000, 'bike')).toBeGreaterThan(estimateDurationMin(5000, 'car'));
  });

  it('returns at least 1 minute and grows with distance', () => {
    expect(estimateDurationMin(0, 'walk')).toBeGreaterThanOrEqual(1);
    expect(estimateDurationMin(10000, 'car')).toBeGreaterThan(estimateDurationMin(1000, 'car'));
  });

  it('builds a deterministic estimate for participant -> spot -> mode', () => {
    const p = participantWithLocation(INDIRANAGAR.lat, INDIRANAGAR.lng);
    const spot = MOCK_SPOTS[0];
    const first = buildRouteEstimate('room-1', p, spot, 'car');
    const second = buildRouteEstimate('room-1', p, spot, 'car');
    expect(first).toEqual(second);
    expect(first?.distanceM).toBeGreaterThan(0);
    expect(first?.durationMin).toBeGreaterThan(0);
  });

  it('returns null when the participant has no location', () => {
    const p = participantWithLocation(12, 77);
    p.location = null;
    expect(buildRouteEstimate('room-1', p, MOCK_SPOTS[0], 'car')).toBeNull();
  });

  it('builds estimates for every participant x spot x mode', () => {
    const participants = MOCK_FRIENDS.map((f, i) => ({
      ...participantWithLocation(f.location.lat, f.location.lng),
      id: `p-${i}`,
    }));
    const estimates = buildAllRouteEstimates('room-1', participants, MOCK_SPOTS);
    // 4 participants x 3 spots x 4 modes
    expect(estimates).toHaveLength(48);
  });

  it('mock data has exactly 4 friends and 3 spots', () => {
    expect(MOCK_FRIENDS).toHaveLength(4);
    expect(MOCK_SPOTS).toHaveLength(3);
    expect(new Set(MOCK_FRIENDS.map((f) => f.name)).size).toBe(4);
    expect(new Set(MOCK_SPOTS.map((s) => s.name)).size).toBe(3);
  });
});
