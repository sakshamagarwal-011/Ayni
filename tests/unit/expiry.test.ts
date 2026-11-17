import { describe, expect, it } from 'vitest';
import {
  expiredLocationMessage,
  freshParticipants,
  hasFreshLocation,
  isRoomExpired,
  timeUntilExpiry,
} from '../../src/coordination/expiry';
import type { Participant } from '../../src/types';

const NOW = new Date('2026-11-17T18:00:00.000Z');

function room(status: 'lobby' | 'finalized' | 'expired', expiresAt: string) {
  return { status, expiresAt };
}

function participant(id: string, expiresAt: string | null): Participant {
  return {
    id,
    roomId: 'room-1',
    authUid: `auth-${id}`,
    displayName: id,
    avatarColor: '#fff',
    isHost: false,
    isReady: false,
    arrivedAt: null,
    joinedAt: '2026-11-17T17:00:00.000Z',
    lastSeenAt: '2026-11-17T17:00:00.000Z',
    location:
      expiresAt === null
        ? null
        : {
            id: `loc-${id}`,
            participantId: id,
            roomId: 'room-1',
            lat: 12.9,
            lng: 77.6,
            label: 'Somewhere',
            accuracyM: null,
            updatedAt: '2026-11-17T17:00:00.000Z',
            expiresAt,
          },
  };
}

describe('isRoomExpired', () => {
  it('is false for an open room whose expiry is in the future', () => {
    expect(isRoomExpired(room('lobby', '2026-11-17T19:00:00.000Z'), NOW)).toBe(false);
  });
  it('is true when expiresAt has passed', () => {
    expect(isRoomExpired(room('lobby', '2026-11-17T17:59:59.000Z'), NOW)).toBe(true);
  });
  it('is true when the status is expired even if expiresAt is in the future', () => {
    expect(isRoomExpired(room('expired', '2026-11-17T19:00:00.000Z'), NOW)).toBe(true);
  });
  it('is NEVER true for finalized rooms (the destination must keep showing)', () => {
    expect(isRoomExpired(room('finalized', '2026-11-17T17:00:00.000Z'), NOW)).toBe(false);
  });
  it('treats an unparseable expiresAt as not expired', () => {
    expect(isRoomExpired(room('lobby', 'not-a-date'), NOW)).toBe(false);
  });
});

describe('timeUntilExpiry', () => {
  it('labels minutes under an hour', () => {
    const info = timeUntilExpiry(room('lobby', '2026-11-17T18:45:00.000Z'), NOW);
    expect(info.expired).toBe(false);
    expect(info.label).toBe('Expires in 45 min');
  });
  it('labels hours and minutes', () => {
    const info = timeUntilExpiry(room('lobby', '2026-11-17T21:30:00.000Z'), NOW);
    expect(info.label).toBe('Expires in 3 h 30 min');
  });
  it('labels whole hours without minutes', () => {
    const info = timeUntilExpiry(room('lobby', '2026-11-17T20:00:00.000Z'), NOW);
    expect(info.label).toBe('Expires in 2 h');
  });
  it('labels expired rooms', () => {
    const info = timeUntilExpiry(room('lobby', '2026-11-17T17:00:00.000Z'), NOW);
    expect(info).toMatchObject({ expired: true, msRemaining: 0, label: 'Expired' });
  });
});

describe('hasFreshLocation / freshParticipants', () => {
  it('is true for locations expiring in the future', () => {
    expect(hasFreshLocation(participant('p1', '2026-11-17T19:00:00.000Z'), NOW)).toBe(true);
  });
  it('is false for expired locations and for no location', () => {
    expect(hasFreshLocation(participant('p1', '2026-11-17T17:00:00.000Z'), NOW)).toBe(false);
    expect(hasFreshLocation(participant('p1', null), NOW)).toBe(false);
  });
  it('filters to fresh participants only', () => {
    const list = [
      participant('fresh', '2026-11-17T19:00:00.000Z'),
      participant('stale', '2026-11-17T17:00:00.000Z'),
      participant('none', null),
    ];
    expect(freshParticipants(list, NOW).map((p) => p.id)).toEqual(['fresh']);
  });
});

describe('expiredLocationMessage', () => {
  it('asks for an update without revealing coordinates', () => {
    const message = expiredLocationMessage();
    expect(message).toContain('expired');
    expect(message).not.toMatch(/\d+\.\d+/);
  });
});
