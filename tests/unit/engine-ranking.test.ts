import { describe, expect, it } from 'vitest';
import { rankCandidates } from '../../src/engine/ranking';
import type { CandidatePlace, ParticipantOrigin, TravelResult } from '../../src/engine/types';

function origin(id: string, name: string, required = true): ParticipantOrigin {
  return {
    participantId: id,
    displayName: name,
    lat: 12.97,
    lng: 77.64,
    mode: 'car',
    required,
    locationUpdatedAt: '2026-11-17T11:30:00.000Z',
    locationExpiresAt: '2026-11-17T14:00:00.000Z',
    consentGiven: true,
  };
}

function place(osmId: string, name: string): CandidatePlace {
  return { osmId, name, category: 'Café', lat: 12.97, lng: 77.64, source: 'overpass' };
}

function result(participantId: string, candidateId: string, durationMin: number | null): TravelResult {
  return {
    participantId,
    candidateId,
    mode: 'car',
    durationMin,
    distanceM: durationMin === null ? null : durationMin * 500,
    reachable: durationMin !== null,
    source: 'osrm',
  };
}

const ORIGINS = [origin('p1', 'Aarav'), origin('p2', 'Priya')];

function resultsMap(entries: Array<[string, TravelResult[]]>): Map<string, TravelResult[]> {
  return new Map(entries);
}

describe('rankCandidates', () => {
  it('ranks by balanced score and explains each candidate', () => {
    const a = place('node/1', 'Alpha Café');
    const b = place('node/2', 'Beta Café');
    const { ranked, excluded } = rankCandidates({
      candidates: [a, b],
      resultsByCandidate: resultsMap([
        ['node/1', [result('p1', 'node/1', 10), result('p2', 'node/1', 30)]],
        ['node/2', [result('p1', 'node/2', 20), result('p2', 'node/2', 20)]],
      ]),
      origins: ORIGINS,
      preference: 'balanced',
    });
    expect(excluded).toEqual([]);
    // Balanced: A = 0.4*20+0.4*30+0.2*10 = 22; B = 0.4*20+0.4*20+0 = 16. B wins.
    expect(ranked.map((r) => r.candidate.name)).toEqual(['Beta Café', 'Alpha Café']);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
    expect(ranked[0].explanation).toContain('Balanced score');
    expect(ranked[0].explanation).toContain('score 16.0');
    expect(ranked[0].explanation).toContain('average 20 min');
    expect(ranked[1].explanation).toContain('Priya');
    expect(ranked[1].explanation).toContain('Longest trip');
  });

  it('minTotal ranks by sum, minimax by longest trip', () => {
    const a = place('node/1', 'Alpha');
    const b = place('node/2', 'Beta');
    const results = resultsMap([
      ['node/1', [result('p1', 'node/1', 10), result('p2', 'node/1', 30)]],
      ['node/2', [result('p1', 'node/2', 22), result('p2', 'node/2', 22)]],
    ]);
    const byTotal = rankCandidates({ candidates: [a, b], resultsByCandidate: results, origins: ORIGINS, preference: 'minTotal' });
    expect(byTotal.ranked[0].candidate.name).toBe('Alpha'); // 40 < 44
    const byMinimax = rankCandidates({ candidates: [a, b], resultsByCandidate: results, origins: ORIGINS, preference: 'minimax' });
    expect(byMinimax.ranked[0].candidate.name).toBe('Beta'); // max 22 < 30
  });

  it('breaks ties by max, then total, then name', () => {
    const a = place('node/1', 'Zulu');
    const b = place('node/2', 'Alpha');
    const { ranked } = rankCandidates({
      candidates: [a, b],
      resultsByCandidate: resultsMap([
        ['node/1', [result('p1', 'node/1', 20), result('p2', 'node/1', 20)]],
        ['node/2', [result('p1', 'node/2', 20), result('p2', 'node/2', 20)]],
      ]),
      origins: ORIGINS,
      preference: 'balanced',
    });
    expect(ranked.map((r) => r.candidate.name)).toEqual(['Alpha', 'Zulu']);
  });

  it('excludes candidates unreachable for any REQUIRED participant, with reasons', () => {
    const a = place('node/1', 'Reachable');
    const b = place('node/2', 'Unreachable');
    const { ranked, excluded } = rankCandidates({
      candidates: [a, b],
      resultsByCandidate: resultsMap([
        ['node/1', [result('p1', 'node/1', 10), result('p2', 'node/1', 10)]],
        ['node/2', [result('p1', 'node/2', 10), result('p2', 'node/2', null)]],
      ]),
      origins: ORIGINS,
      preference: 'balanced',
    });
    expect(ranked.map((r) => r.candidate.name)).toEqual(['Reachable']);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].reason).toContain('Priya');
    expect(excluded[0].reason).toContain('Unreachable');
  });

  it('does not exclude for unreachable OPTIONAL participants, and scores required only', () => {
    const origins = [origin('p1', 'Aarav'), origin('p2', 'Priya', false)];
    const a = place('node/1', 'Solo');
    const { ranked, excluded } = rankCandidates({
      candidates: [a],
      resultsByCandidate: resultsMap([['node/1', [result('p1', 'node/1', 15), result('p2', 'node/1', null)]]]),
      origins,
      preference: 'balanced',
    });
    expect(excluded).toEqual([]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].totalMin).toBe(15);
    expect(ranked[0].perParticipant).toHaveLength(2);
  });

  it('excludes candidates over the max-travel limit for required participants', () => {
    const a = place('node/1', 'Near');
    const b = place('node/2', 'Far');
    const { ranked, excluded } = rankCandidates({
      candidates: [a, b],
      resultsByCandidate: resultsMap([
        ['node/1', [result('p1', 'node/1', 10), result('p2', 'node/1', 20)]],
        ['node/2', [result('p1', 'node/2', 10), result('p2', 'node/2', 61)]],
      ]),
      origins: ORIGINS,
      preference: 'balanced',
      maxTravelMinutes: 60,
    });
    expect(ranked.map((r) => r.candidate.name)).toEqual(['Near']);
    expect(excluded[0].reason).toContain('60-minute');
    expect(excluded[0].reason).toContain('Priya (61 min)');
  });

  it('treats the max-travel boundary as inclusive', () => {
    const a = place('node/1', 'Edge');
    const { ranked, excluded } = rankCandidates({
      candidates: [a],
      resultsByCandidate: resultsMap([['node/1', [result('p1', 'node/1', 60), result('p2', 'node/1', 60)]]]),
      origins: ORIGINS,
      preference: 'balanced',
      maxTravelMinutes: 60,
    });
    expect(ranked).toHaveLength(1);
    expect(excluded).toEqual([]);
  });

  it('returns at most the top 5', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => place(`node/${i}`, `Place ${i}`));
    const results = resultsMap(
      candidates.map((c, i) => [c.osmId, [result('p1', c.osmId, 10 + i), result('p2', c.osmId, 10 + i)]] as [string, TravelResult[]]),
    );
    const { ranked } = rankCandidates({ candidates, resultsByCandidate: results, origins: ORIGINS, preference: 'minTotal' });
    expect(ranked).toHaveLength(5);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});
