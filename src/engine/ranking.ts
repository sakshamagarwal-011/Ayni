import { MODE_LABELS } from '../lib/distance';
import { scoreCandidate, summarizeDurations } from './scoring';
import {
  PREFERENCE_LABELS,
  type CandidatePlace,
  type ExcludedCandidate,
  type OptimizationPreference,
  type ParticipantOrigin,
  type ScoredCandidate,
  type TravelResult,
} from './types';

/**
 * Steps 7, 9, 10 — exclude, rank, explain. Pure.
 *
 * - Step 7: a candidate is excluded when ANY required participant is
 *   unreachable or has no result. Optional participants never exclude.
 * - Step 9: a candidate is excluded when ANY required duration exceeds
 *   maxTravelMinutes (when set).
 * - Step 10: sort by (score, max, total, name) — documented stable
 *   tie-breaks — take the top 5, and explain each ranking in words.
 *
 * Scoring uses REQUIRED participants' durations only. Optional
 * participants' results are carried in `perParticipant` for display.
 * No straight-line distance appears anywhere in this file: durations
 * arrive from the routing endpoint via TravelResult.
 */

export interface RankingInput {
  candidates: CandidatePlace[];
  /** Travel results keyed by candidate osmId. */
  resultsByCandidate: Map<string, TravelResult[]>;
  origins: ParticipantOrigin[];
  preference: OptimizationPreference;
  maxTravelMinutes?: number;
  topN?: number;
}

export interface RankingOutput {
  ranked: ScoredCandidate[];
  excluded: ExcludedCandidate[];
}

function formatMinutes(min: number): string {
  return `${Math.round(min)} min`;
}

export function buildExplanation(
  candidate: CandidatePlace,
  stats: { total: number; average: number; max: number; stdDev: number },
  score: number,
  preference: OptimizationPreference,
  longest: { origin: ParticipantOrigin; durationMin: number } | null,
  requiredCount: number,
): string {
  const strategy = PREFERENCE_LABELS[preference];
  const longestPart = longest
    ? ` Longest trip: ${longest.origin.displayName} (${MODE_LABELS[longest.origin.mode].toLowerCase()}, ${formatMinutes(longest.durationMin)}).`
    : '';
  return (
    `${candidate.name} ranks by ${strategy} (score ${score.toFixed(1)}): ` +
    `total ${formatMinutes(stats.total)}, average ${formatMinutes(stats.average)}, longest ${formatMinutes(stats.max)} ` +
    `across ${requiredCount} required participant${requiredCount === 1 ? '' : 's'}.` +
    longestPart
  );
}

export function rankCandidates(input: RankingInput): RankingOutput {
  const { candidates, resultsByCandidate, origins, preference } = input;
  const topN = input.topN ?? 5;
  const required = origins.filter((o) => o.required);
  const ranked: ScoredCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const candidate of candidates) {
    const results = resultsByCandidate.get(candidate.osmId) ?? [];
    const byParticipant = new Map(results.map((r) => [r.participantId, r]));

    // Step 7 — unreachable / missing for a required participant.
    const unreachable: string[] = [];
    for (const origin of required) {
      const result = byParticipant.get(origin.participantId);
      if (!result || !result.reachable || result.durationMin === null) {
        unreachable.push(origin.displayName);
      }
    }
    if (unreachable.length > 0) {
      excluded.push({
        candidate,
        reason: `Unreachable for: ${unreachable.join(', ')}.`,
      });
      continue;
    }

    // Step 9 — maximum travel-time constraint (required participants only).
    if (input.maxTravelMinutes !== undefined) {
      const over: string[] = [];
      for (const origin of required) {
        const result = byParticipant.get(origin.participantId)!;
        if ((result.durationMin ?? 0) > input.maxTravelMinutes) {
          over.push(`${origin.displayName} (${formatMinutes(result.durationMin ?? 0)})`);
        }
      }
      if (over.length > 0) {
        excluded.push({
          candidate,
          reason: `Exceeds the ${input.maxTravelMinutes}-minute limit for: ${over.join(', ')}.`,
        });
        continue;
      }
    }

    const durations = required.map((o) => byParticipant.get(o.participantId)!.durationMin!);
    const stats = summarizeDurations(durations);
    const score = scoreCandidate(durations, preference);
    let longest: { origin: ParticipantOrigin; durationMin: number } | null = null;
    for (const origin of required) {
      const durationMin = byParticipant.get(origin.participantId)!.durationMin!;
      if (!longest || durationMin > longest.durationMin) longest = { origin, durationMin };
    }
    ranked.push({
      candidate,
      perParticipant: results,
      totalMin: stats.total,
      averageMin: stats.average,
      maxMin: stats.max,
      stdDevMin: stats.stdDev,
      score,
      rank: 0, // Assigned after sorting.
      explanation: buildExplanation(candidate, stats, score, preference, longest, required.length),
    });
  }

  ranked.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.maxMin !== b.maxMin) return a.maxMin - b.maxMin;
    if (a.totalMin !== b.totalMin) return a.totalMin - b.totalMin;
    return a.candidate.name.localeCompare(b.candidate.name);
  });
  const top = ranked.slice(0, topN);
  top.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  // Candidates beyond the top 5 are neither ranked nor "excluded":
  // they simply did not make the cut. Only true exclusions are listed.
  return { ranked: top, excluded };
}
