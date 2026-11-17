import { describe, expect, it } from 'vitest';
import { arrivalLabel, arrivalSummary } from '../../src/coordination/arrival';
import type { Participant } from '../../src/types';

function participant(name: string, arrivedAt: string | null): Participant {
  return {
    id: name,
    roomId: 'room-1',
    authUid: `auth-${name}`,
    displayName: name,
    avatarColor: '#fff',
    isHost: false,
    isReady: false,
    arrivedAt,
    joinedAt: '2026-11-17T17:00:00.000Z',
    lastSeenAt: '2026-11-17T17:00:00.000Z',
    location: null,
  };
}

describe('arrivalLabel', () => {
  it('labels arrived participants', () => {
    expect(arrivalLabel(participant('A', '2026-11-17T18:00:00.000Z'))).toBe('Arrived ✓');
  });
  it('labels participants still on the way', () => {
    expect(arrivalLabel(participant('A', null))).toBe('On the way');
  });
});

describe('arrivalSummary', () => {
  it('counts arrivals and names', () => {
    const summary = arrivalSummary([
      participant('A', '2026-11-17T18:00:00.000Z'),
      participant('B', null),
      participant('C', '2026-11-17T18:05:00.000Z'),
      participant('D', null),
    ]);
    expect(summary.arrivedCount).toBe(2);
    expect(summary.totalCount).toBe(4);
    expect(summary.arrivedNames).toEqual(['A', 'C']);
  });
  it('handles an empty room', () => {
    expect(arrivalSummary([])).toEqual({ arrivedCount: 0, totalCount: 0, arrivedNames: [] });
  });
});
