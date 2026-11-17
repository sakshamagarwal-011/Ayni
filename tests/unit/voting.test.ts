import { describe, expect, it } from 'vitest';
import {
  COMPARED_SPOTS_LIMIT,
  groupWinner,
  orderSpotsByTally,
  ownRanking,
  readEngineSpotOrder,
  saveEngineSpotOrder,
  selectComparedSpots,
  tallyVotes,
  validateRanking,
  validateVoteSubmission,
  voterParticipation,
} from '../../src/coordination/voting';
import type { MeetingSpot, Vote } from '../../src/types';

function vote(participantId: string, spotId: string, rank: number): Vote {
  return { id: `${participantId}-${spotId}`, roomId: 'room-1', participantId, spotId, rank };
}

function spot(id: string, name: string): MeetingSpot {
  return {
    id,
    name,
    category: 'cafe',
    address: `${name} address`,
    location: { lat: 12.9, lng: 77.6 },
    rating: 4.5,
    priceLevel: 2,
    openNow: true,
    source: 'mock',
  };
}

describe('validateRanking', () => {
  const compared = ['a', 'b', 'c'];
  it('accepts a full permutation', () => {
    expect(validateRanking(['b', 'a', 'c'], compared)).toEqual([]);
  });
  it('rejects empty rankings', () => {
    expect(validateRanking([], compared).length).toBeGreaterThan(0);
  });
  it('rejects duplicates', () => {
    expect(validateRanking(['a', 'a', 'b'], compared).some((m) => m.includes('more than once'))).toBe(true);
  });
  it('rejects unknown spots', () => {
    expect(validateRanking(['a', 'b', 'zzz'], compared).some((m) => m.includes('not being compared'))).toBe(true);
  });
  it('rejects rankings missing a compared spot', () => {
    expect(validateRanking(['a', 'b'], compared).some((m) => m.includes('missing'))).toBe(true);
  });
});

describe('validateVoteSubmission', () => {
  it('accepts a subset permutation of room spots', () => {
    expect(validateVoteSubmission(['b', 'a'], ['a', 'b', 'c'])).toEqual([]);
  });
  it('rejects empty, duplicate, and unknown ids', () => {
    expect(validateVoteSubmission([], ['a'])).toHaveLength(1);
    expect(validateVoteSubmission(['a', 'a'], ['a', 'b']).length).toBeGreaterThan(0);
    expect(validateVoteSubmission(['zzz'], ['a', 'b']).length).toBeGreaterThan(0);
  });
});

describe('tallyVotes', () => {
  it('counts first choices, Borda scores, average ranks, and voters', () => {
    const votes = [
      vote('p1', 'a', 1),
      vote('p1', 'b', 2),
      vote('p1', 'c', 3),
      vote('p2', 'b', 1),
      vote('p2', 'a', 2),
      vote('p2', 'c', 3),
    ];
    const tally = tallyVotes(votes, ['a', 'b', 'c']);
    expect(tally.voters).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(tally.totalVotes).toBe(6);
    const byId = new Map(tally.perSpot.map((t) => [t.spotId, t]));
    // 3 spots: rank 1 earns 2, rank 2 earns 1, rank 3 earns 0.
    expect(byId.get('a')).toMatchObject({ firstChoiceCount: 1, bordaScore: 3, averageRank: 1.5, voterCount: 2 });
    expect(byId.get('b')).toMatchObject({ firstChoiceCount: 1, bordaScore: 3, averageRank: 1.5, voterCount: 2 });
    expect(byId.get('c')).toMatchObject({ firstChoiceCount: 0, bordaScore: 0, averageRank: 3, voterCount: 2 });
  });
  it('ignores votes for spots outside the compared set in per-spot tallies', () => {
    const tally = tallyVotes([vote('p1', 'zzz', 1), vote('p1', 'a', 1)], ['a']);
    expect(tally.perSpot[0].firstChoiceCount).toBe(1);
    expect(tally.voters).toContain('p1');
  });
  it('reports Infinity average rank for unranked spots', () => {
    const tally = tallyVotes([vote('p1', 'a', 1)], ['a', 'b']);
    expect(tally.perSpot[1].averageRank).toBe(Infinity);
    expect(tally.perSpot[1].voterCount).toBe(0);
  });
});

describe('groupWinner tie-breaks', () => {
  const names = new Map([
    ['a', 'Alpha'],
    ['b', 'Beta'],
    ['c', 'Gamma'],
  ]);
  it('returns null when nobody voted', () => {
    expect(groupWinner(tallyVotes([], ['a', 'b']), names)).toBeNull();
  });
  it('prefers the most first-choice votes', () => {
    const tally = tallyVotes(
      [vote('p1', 'a', 1), vote('p2', 'a', 1), vote('p3', 'b', 1), vote('p3', 'a', 2)],
      ['a', 'b'],
    );
    expect(groupWinner(tally, names)).toBe('a');
  });
  it('breaks first-choice ties by Borda score', () => {
    // a and b each get one first choice; b gets more second-choice points.
    const tally = tallyVotes(
      [vote('p1', 'a', 1), vote('p1', 'b', 2), vote('p1', 'c', 3), vote('p2', 'b', 1), vote('p2', 'c', 2), vote('p2', 'a', 3)],
      ['a', 'b', 'c'],
    );
    // a: first 1, borda 2+0=2. b: first 1, borda 1+2=3. b wins on Borda.
    expect(groupWinner(tally, names)).toBe('b');
  });
  it('breaks Borda ties by average rank, then name', () => {
    const tally = tallyVotes([vote('p1', 'b', 1), vote('p1', 'a', 2)], ['a', 'b']);
    // b wins outright on first choice; construct an exact tie instead:
    const tied = tallyVotes([vote('p1', 'a', 1), vote('p2', 'b', 1)], ['a', 'b']);
    // a and b: 1 first choice, Borda 1, avg rank 1 -> name order: Alpha (a) wins.
    expect(groupWinner(tied, names)).toBe('a');
    expect(groupWinner(tally, names)).toBe('b');
  });
});

describe('selectComparedSpots / top-5 cap', () => {
  const spots = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => spot(id, `Spot ${id.toUpperCase()}`));
  it('caps at 5 spots and reports the cap', () => {
    const { compared, capped, total } = selectComparedSpots(spots, []);
    expect(compared).toHaveLength(COMPARED_SPOTS_LIMIT);
    expect(COMPARED_SPOTS_LIMIT).toBe(5);
    expect(capped).toBe(true);
    expect(total).toBe(7);
  });
  it('orders by group tally when no engine order is present', () => {
    const votes = [vote('p1', 'g', 1), vote('p1', 'a', 2), vote('p2', 'g', 1)];
    const { compared } = selectComparedSpots(spots, votes);
    expect(compared[0].id).toBe('g');
  });
  it('uses the engine order when present', () => {
    const { compared } = selectComparedSpots(spots, [], ['f', 'e', 'd', 'c', 'b', 'a', 'g']);
    expect(compared.map((s) => s.id)).toEqual(['f', 'e', 'd', 'c', 'b']);
  });
  it('does not cap when there are 5 or fewer spots', () => {
    const { compared, capped } = selectComparedSpots(spots.slice(0, 3), []);
    expect(compared).toHaveLength(3);
    expect(capped).toBe(false);
  });
});

describe('ownRanking / voterParticipation', () => {
  const votes = [vote('p1', 'b', 2), vote('p1', 'a', 1), vote('p2', 'a', 1)];
  it('returns the participant ranking in rank order', () => {
    expect(ownRanking(votes, 'p1', ['a', 'b'])).toEqual(['a', 'b']);
  });
  it('returns null when the participant has not voted', () => {
    expect(ownRanking(votes, 'p3', ['a', 'b'])).toBeNull();
  });
  it('counts participation without exposing rankings', () => {
    const p = voterParticipation(votes, ['p1', 'p2', 'p3']);
    expect(p.votedCount).toBe(2);
    expect(p.totalCount).toBe(3);
    expect(p.voted).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(p.notVoted).toEqual(['p3']);
  });
});

describe('orderSpotsByTally', () => {
  it('puts voted spots in winner order, then unvoted in input order', () => {
    const spots = [spot('a', 'A'), spot('b', 'B'), spot('c', 'C')];
    const tally = tallyVotes([vote('p1', 'c', 1), vote('p1', 'a', 2)], ['a', 'b', 'c']);
    const names = new Map(spots.map((s) => [s.id, s.name]));
    expect(orderSpotsByTally(spots, tally, names).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('engine spot order storage', () => {
  function memoryStorage(): Map<string, string> & Pick<Storage, 'getItem' | 'setItem'> {
    const map = new Map<string, string>();
    return Object.assign(map, {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    });
  }
  it('round-trips an order for the matching decision version', () => {
    const storage = memoryStorage();
    saveEngineSpotOrder(storage, 'room-1', { spotIds: ['b', 'a'], decisionVersion: 3, generatedAt: '2026-11-17T00:00:00.000Z' });
    expect(readEngineSpotOrder(storage, 'room-1', 3)).toEqual(['b', 'a']);
  });
  it('rejects a stored order when the decision version changed', () => {
    const storage = memoryStorage();
    saveEngineSpotOrder(storage, 'room-1', { spotIds: ['b', 'a'], decisionVersion: 3, generatedAt: '2026-11-17T00:00:00.000Z' });
    expect(readEngineSpotOrder(storage, 'room-1', 4)).toBeUndefined();
  });
  it('returns undefined for missing or corrupt data', () => {
    const storage = memoryStorage();
    expect(readEngineSpotOrder(storage, 'room-1', 1)).toBeUndefined();
    storage.setItem('meetsync-engine-order-room-1', 'not-json');
    expect(readEngineSpotOrder(storage, 'room-1', 1)).toBeUndefined();
  });
  it('tolerates a null storage (private mode)', () => {
    expect(() => saveEngineSpotOrder(null, 'room-1', { spotIds: [], decisionVersion: 1, generatedAt: '' })).not.toThrow();
    expect(readEngineSpotOrder(null, 'room-1', 1)).toBeUndefined();
  });
});
