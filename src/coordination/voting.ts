/**
 * Voting: one active ranking per participant, group tally, top-five
 * comparison set. Pure: no service imports, no I/O.
 *
 * Semantics (see COORDINATION.md):
 * - One active RANKING per participant: a ranked list over the compared
 *   spots. Saving replaces the previous ranking; the votes table's
 *   unique constraint on (room, participant, spot) plus replace-on-save
 *   in both services guarantees no duplicate active votes.
 * - The group winner is computed from ALL participants' rankings with
 *   documented tie-breaks. Finalization uses the group winner by
 *   default (or a host-selected top-five spot), never one person's #1.
 * - Privacy: members can read votes under RLS, but the UI shows only
 *   aggregates (tally + participation) plus each person's OWN ranking.
 *   Other participants' full rankings are never displayed.
 */

import type { MeetingSpot, Vote } from '../types';

export interface SpotTally {
  spotId: string;
  /** Number of participants who ranked this spot #1. */
  firstChoiceCount: number;
  /** Borda score: a rank r in a set of N earns (N - r) points. Higher is better. */
  bordaScore: number;
  /** Mean rank among participants who ranked this spot (Infinity when unranked). Lower is better. */
  averageRank: number;
  /** Distinct participants who ranked this spot. */
  voterCount: number;
}

export interface VoteTally {
  /** One entry per compared spot, in the input spot order. */
  perSpot: SpotTally[];
  /** Distinct participant ids who cast any vote. */
  voters: string[];
  /** Total number of vote rows. */
  totalVotes: number;
}

/**
 * Validate a ranking against the compared set: it must be a permutation
 * (every compared spot exactly once, nothing else, non-empty).
 * Returns every issue found (empty = valid). Used by the UI.
 */
export function validateRanking(rankedSpotIds: string[], comparedSpotIds: string[]): string[] {
  const issues: string[] = [];
  if (rankedSpotIds.length === 0) {
    issues.push('Your ranking is empty — rank at least one spot.');
    return issues;
  }
  const seen = new Set<string>();
  for (const id of rankedSpotIds) {
    if (seen.has(id)) issues.push('Your ranking contains a spot more than once.');
    seen.add(id);
  }
  const compared = new Set(comparedSpotIds);
  for (const id of rankedSpotIds) {
    if (!compared.has(id)) issues.push('Your ranking contains a spot that is not being compared.');
  }
  for (const id of comparedSpotIds) {
    if (!seen.has(id)) issues.push('Your ranking is missing a compared spot.');
  }
  return [...new Set(issues)];
}

/**
 * Validate a vote submission against the room's spots (service-level):
 * non-empty, unique, every id a room spot. The service does not know
 * the UI's compared set, so it validates a subset-permutation; the UI
 * validates the full permutation with validateRanking().
 */
export function validateVoteSubmission(rankedSpotIds: string[], roomSpotIds: string[]): string[] {
  const issues: string[] = [];
  if (rankedSpotIds.length === 0) {
    issues.push('Your ranking is empty — rank at least one spot.');
    return issues;
  }
  const seen = new Set<string>();
  for (const id of rankedSpotIds) {
    if (seen.has(id)) issues.push('Your ranking contains a spot more than once.');
    seen.add(id);
  }
  const room = new Set(roomSpotIds);
  for (const id of rankedSpotIds) {
    if (!room.has(id)) issues.push('Your ranking contains a spot that does not belong to this room.');
  }
  return [...new Set(issues)];
}

export function tallyVotes(votes: Vote[], spotIds: string[]): VoteTally {
  const spotCount = spotIds.length;
  const bySpot = new Map<string, { ranks: number[]; voters: Set<string> }>();
  for (const id of spotIds) bySpot.set(id, { ranks: [], voters: new Set() });
  const voters = new Set<string>();
  for (const vote of votes) {
    voters.add(vote.participantId);
    const entry = bySpot.get(vote.spotId);
    if (!entry) continue; // Vote for a spot outside the compared set: ignore for tally.
    entry.ranks.push(vote.rank);
    entry.voters.add(vote.participantId);
  }
  const perSpot: SpotTally[] = spotIds.map((spotId) => {
    const entry = bySpot.get(spotId)!;
    const firstChoiceCount = entry.ranks.filter((r) => r === 1).length;
    const bordaScore = entry.ranks.reduce((sum, r) => sum + Math.max(0, spotCount - r), 0);
    const averageRank =
      entry.ranks.length > 0 ? entry.ranks.reduce((sum, r) => sum + r, 0) / entry.ranks.length : Infinity;
    return { spotId, firstChoiceCount, bordaScore, averageRank, voterCount: entry.voters.size };
  });
  return { perSpot, voters: [...voters], totalVotes: votes.length };
}

/**
 * Group winner tie-breaks (documented, deterministic):
 * 1. Most first-choice votes. 2. Highest Borda score. 3. Lowest average
 * rank. 4. Spot name (A–Z). Returns null when nobody has voted.
 */
export function groupWinner(tally: VoteTally, spotNameById: Map<string, string>): string | null {
  if (tally.voters.length === 0) return null;
  const ranked = [...tally.perSpot].filter((t) => t.voterCount > 0);
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => {
    if (a.firstChoiceCount !== b.firstChoiceCount) return b.firstChoiceCount - a.firstChoiceCount;
    if (a.bordaScore !== b.bordaScore) return b.bordaScore - a.bordaScore;
    if (a.averageRank !== b.averageRank) return a.averageRank - b.averageRank;
    return (spotNameById.get(a.spotId) ?? a.spotId).localeCompare(spotNameById.get(b.spotId) ?? b.spotId);
  });
  return ranked[0].spotId;
}

/** Order spots by group preference for display: voted spots first (winner order), then unvoted in input order. */
export function orderSpotsByTally(
  spots: MeetingSpot[],
  tally: VoteTally,
  spotNameById: Map<string, string>,
): MeetingSpot[] {
  const tallyById = new Map(tally.perSpot.map((t) => [t.spotId, t]));
  const indexById = new Map(spots.map((s, i) => [s.id, i]));
  return [...spots].sort((a, b) => {
    const ta = tallyById.get(a.id);
    const tb = tallyById.get(b.id);
    const va = ta?.voterCount ?? 0;
    const vb = tb?.voterCount ?? 0;
    if (va === 0 && vb === 0) return (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0);
    if (va === 0) return 1;
    if (vb === 0) return -1;
    if (ta!.firstChoiceCount !== tb!.firstChoiceCount) return tb!.firstChoiceCount - ta!.firstChoiceCount;
    if (ta!.bordaScore !== tb!.bordaScore) return tb!.bordaScore - ta!.bordaScore;
    if (ta!.averageRank !== tb!.averageRank) return ta!.averageRank - tb!.averageRank;
    return (spotNameById.get(a.id) ?? a.id).localeCompare(spotNameById.get(b.id) ?? b.id);
  });
}

export const COMPARED_SPOTS_LIMIT = 5;

export interface ComparedSpots {
  compared: MeetingSpot[];
  /** True when the room has more spots than the comparison limit. */
  capped: boolean;
  total: number;
}

/**
 * The compared set: at most 5 spots. When an engine result is present
 * (ordered spot ids from the last optimization search, stored by the
 * Route Discovery panel), matching room spots lead in engine order and
 * the remainder follow by group tally. Otherwise the room's spots are
 * ordered by group tally. Engine ordering is a display hint only — it
 * never decides finalization (the group winner does).
 */
export function selectComparedSpots(
  spots: MeetingSpot[],
  votes: Vote[],
  engineSpotOrder?: string[],
): ComparedSpots {
  const spotNameById = new Map(spots.map((s) => [s.id, s.name]));
  const tally = tallyVotes(votes, spots.map((s) => s.id));
  const byTally = orderSpotsByTally(spots, tally, spotNameById);
  let ordered: MeetingSpot[];
  const order = (engineSpotOrder ?? []).filter((id) => spots.some((s) => s.id === id));
  if (order.length > 0) {
    const inEngineOrder = order
      .map((id) => spots.find((s) => s.id === id)!)
      .filter((s): s is MeetingSpot => Boolean(s));
    const rest = byTally.filter((s) => !order.includes(s.id));
    ordered = [...inEngineOrder, ...rest];
  } else {
    ordered = byTally;
  }
  return { compared: ordered.slice(0, COMPARED_SPOTS_LIMIT), capped: spots.length > COMPARED_SPOTS_LIMIT, total: spots.length };
}

/**
 * A participant's saved ranking, ordered by rank and restricted to the
 * compared set, with any unranked compared spots appended in compared
 * order. Returns null when the participant has not voted.
 */
export function ownRanking(votes: Vote[], participantId: string, comparedIds: string[]): string[] | null {
  const mine = votes
    .filter((v) => v.participantId === participantId)
    .sort((a, b) => a.rank - b.rank)
    .map((v) => v.spotId)
    .filter((id) => comparedIds.includes(id));
  if (mine.length === 0) return null;
  const missing = comparedIds.filter((id) => !mine.includes(id));
  return [...mine, ...missing];
}

export interface Participation {
  voted: string[];
  notVoted: string[];
  votedCount: number;
  totalCount: number;
}

export function voterParticipation(votes: Vote[], participantIds: string[]): Participation {
  const votedSet = new Set(votes.map((v) => v.participantId));
  const voted = participantIds.filter((id) => votedSet.has(id));
  const notVoted = participantIds.filter((id) => !votedSet.has(id));
  return { voted, notVoted, votedCount: voted.length, totalCount: participantIds.length };
}

// ---------------------------------------------------------------------------
// Engine-order persistence (display hint for the comparison set).
// Stored in sessionStorage by the optimization panel; read by the
// comparison page. A stored order is ignored when its decision version
// no longer matches the room (the room changed since the search).
// ---------------------------------------------------------------------------

export interface StoredEngineOrder {
  spotIds: string[];
  decisionVersion: number;
  generatedAt: string;
}

export type KeyValueStorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function engineOrderStorageKey(roomId: string): string {
  return `meetsync-engine-order-${roomId}`;
}

export function saveEngineSpotOrder(
  storage: KeyValueStorageLike | null | undefined,
  roomId: string,
  order: StoredEngineOrder,
): void {
  if (!storage) return;
  try {
    storage.setItem(engineOrderStorageKey(roomId), JSON.stringify(order));
  } catch {
    // Best-effort display hint; failure is not an error.
  }
}

export function readEngineSpotOrder(
  storage: KeyValueStorageLike | null | undefined,
  roomId: string,
  currentDecisionVersion: number,
): string[] | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(engineOrderStorageKey(roomId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredEngineOrder>;
    if (!Array.isArray(parsed.spotIds) || parsed.decisionVersion !== currentDecisionVersion) {
      return undefined;
    }
    return parsed.spotIds.filter((id): id is string => typeof id === 'string');
  } catch {
    return undefined;
  }
}
