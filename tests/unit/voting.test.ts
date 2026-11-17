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

function spot(id: string, name: string, publishedRank: number | null = null): MeetingSpot {
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
    publishedRank,
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
  it('excludes out-of-set-only voters from voters and totalVotes', () => {
    // p2 voted only for a spot outside the compared set: they are not
    // a voter of this tally and their vote is not counted.
    const tally = tallyVotes([vote('p1', 'a', 1), vote('p2', 'zzz', 1)], ['a']);
    expect(tally.voters).toEqual(['p1']);
    expect(tally.totalVotes).toBe(1);
    expect(tally.perSpot[0].voterCount).toBe(1);
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

describe('selectComparedSpots / shared published order', () => {
  // The live defect (v0.7.0): 3 seeded spots (created first, null
  // rank) + 5 published spots. A viewer with NO engine order must
  // see all 5 published spots, in rank order — not 3 seeded + 2 live.
  function roomWithBatch(): MeetingSpot[] {
    return [
      spot('seed-1', 'Seed One'),
      spot('seed-2', 'Seed Two'),
      spot('seed-3', 'Seed Three'),
      spot('live-1', 'Live One', 1),
      spot('live-2', 'Live Two', 2),
      spot('live-3', 'Live Three', 3),
      spot('live-4', 'Live Four', 4),
      spot('live-5', 'Live Five', 5),
    ];
  }

  it('leads with the published batch in rank order for a viewer with no engine order', () => {
    const { compared, capped, total } = selectComparedSpots(roomWithBatch(), []);
    expect(compared.map((s) => s.id)).toEqual(['live-1', 'live-2', 'live-3', 'live-4', 'live-5']);
    expect(capped).toBe(true);
    expect(total).toBe(8);
  });

  it('orders the remainder by group tally after the published batch', () => {
    const spots = [
      spot('seed-1', 'Seed One'),
      spot('seed-2', 'Seed Two'),
      spot('seed-3', 'Seed Three'),
      spot('live-1', 'Live One', 1),
      spot('live-2', 'Live Two', 2),
    ];
    // One vote for a seeded spot: it must lead the remainder even
    // though the published batch leads overall.
    const votes = [vote('p1', 'seed-3', 1), vote('p1', 'seed-1', 2)];
    const { compared } = selectComparedSpots(spots, votes);
    expect(compared.map((s) => s.id)).toEqual(['live-1', 'live-2', 'seed-3', 'seed-1', 'seed-2']);
  });

  it('keeps engine order precedence when present, even over published ranks', () => {
    const { compared } = selectComparedSpots(roomWithBatch(), [], [
      'seed-2',
      'live-5',
      'seed-1',
      'live-1',
      'live-2',
      'live-3',
      'live-4',
      'seed-3',
    ]);
    expect(compared.map((s) => s.id)).toEqual(['seed-2', 'live-5', 'seed-1', 'live-1', 'live-2']);
  });

  it('behaves exactly as before when all ranks are null', () => {
    const spots = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => spot(id, `Spot ${id.toUpperCase()}`));
    const votes = [vote('p1', 'g', 1), vote('p1', 'a', 2), vote('p2', 'g', 1)];
    const { compared } = selectComparedSpots(spots, votes);
    // Same as the pre-0009 tally order: voted 'g' first, then the
    // rest in input order (no published batch to lead).
    expect(compared.map((s) => s.id)).toEqual(['g', 'a', 'b', 'c', 'd']);
  });

  it('superseded batch spots fall back to tally order once their ranks are cleared', () => {
    // Simulate the server state after a re-publish: batch A spots
    // have null ranks (cleared), batch B spots carry 1..2.
    const spots = [
      spot('seed-1', 'Seed One'),
      spot('old-a', 'Old A'),
      spot('old-b', 'Old B'),
      spot('new-1', 'New One', 1),
      spot('new-2', 'New Two', 2),
    ];
    const votes = [vote('p1', 'old-b', 1)];
    const { compared } = selectComparedSpots(spots, votes);
    // New batch leads; the voted old-batch spot leads the remainder.
    expect(compared.map((s) => s.id)).toEqual(['new-1', 'new-2', 'old-b', 'seed-1', 'old-a']);
  });

  it('ignores a published rank on a spot the engine order already placed (engine order wins)', () => {
    const spots = [spot('a', 'A', 1), spot('b', 'B', 2), spot('c', 'C')];
    const { compared } = selectComparedSpots(spots, [], ['c', 'b', 'a']);
    expect(compared.map((s) => s.id)).toEqual(['c', 'b', 'a']);
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
