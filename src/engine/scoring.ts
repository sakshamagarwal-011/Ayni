import type { OptimizationPreference } from './types';

/**
 * Step 8 — optimization strategies. Pure functions over durations
 * (minutes) that came from the routing endpoint. Lower score is
 * always better, for every strategy.
 *
 * - minTotal:  sum of durations (minimise the group's total travel).
 * - minimax:   longest single duration (minimise the worst trip;
 *              fairness). Ties are broken in ranking.ts (lower total,
 *              then lower spread, then name).
 * - balanced:  0.4 * average + 0.4 * maximum + 0.2 * stdDev
 *              (exact weights from the brief).
 *
 * Standard deviation is the POPULATION stddev:
 *   sqrt(mean((x - mean)^2))
 * Worked example (durations 10, 20, 30): average 20, max 30,
 * stddev sqrt((100+0+100)/3) = 8.165, balanced = 0.4*20 + 0.4*30 +
 * 0.2*8.165 = 21.633. See ENGINE.md.
 */

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function maxValue(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

/** Population standard deviation. Returns 0 for empty / single-value input. */
export function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export interface DurationStats {
  total: number;
  average: number;
  max: number;
  stdDev: number;
}

export function summarizeDurations(durations: number[]): DurationStats {
  return {
    total: durations.reduce((sum, v) => sum + v, 0),
    average: mean(durations),
    max: maxValue(durations),
    stdDev: stdDev(durations),
  };
}

export const BALANCED_WEIGHTS = { average: 0.4, max: 0.4, stdDev: 0.2 } as const;

/** Strategy score for one candidate's required-participant durations. Lower is better. */
export function scoreCandidate(durations: number[], preference: OptimizationPreference): number {
  if (durations.length === 0) {
    throw new RangeError('Cannot score a candidate with no required durations.');
  }
  const stats = summarizeDurations(durations);
  switch (preference) {
    case 'minTotal':
      return stats.total;
    case 'minimax':
      return stats.max;
    case 'balanced':
      return (
        BALANCED_WEIGHTS.average * stats.average +
        BALANCED_WEIGHTS.max * stats.max +
        BALANCED_WEIGHTS.stdDev * stats.stdDev
      );
    default:
      throw new RangeError(`Unknown optimization preference: ${String(preference)}.`);
  }
}
