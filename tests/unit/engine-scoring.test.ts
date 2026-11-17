import { describe, expect, it } from 'vitest';
import { mean, maxValue, stdDev, summarizeDurations, scoreCandidate, BALANCED_WEIGHTS } from '../../src/engine/scoring';

describe('scoring helpers', () => {
  it('computes mean/max/stdDev (population)', () => {
    expect(mean([10, 20, 30])).toBe(20);
    expect(maxValue([10, 20, 30])).toBe(30);
    // sqrt((100 + 0 + 100) / 3) = sqrt(66.666...) = 8.1649658...
    expect(stdDev([10, 20, 30])).toBeCloseTo(8.1649658, 5);
    expect(stdDev([])).toBe(0);
    expect(stdDev([42])).toBe(0);
    expect(mean([])).toBe(0);
    expect(maxValue([])).toBe(0);
  });

  it('summarizes durations', () => {
    expect(summarizeDurations([10, 20, 30])).toEqual({
      total: 60,
      average: 20,
      max: 30,
      stdDev: expect.closeTo(8.1649658, 5),
    });
  });
});

describe('scoreCandidate', () => {
  it('minTotal is the sum', () => {
    expect(scoreCandidate([10, 20, 30], 'minTotal')).toBe(60);
    expect(scoreCandidate([], 'minTotal')).toBe(0);
  });

  it('minimax is the longest trip', () => {
    expect(scoreCandidate([10, 20, 30], 'minimax')).toBe(30);
    expect(scoreCandidate([5, 5, 5], 'minimax')).toBe(5);
  });

  it('balanced uses the exact 0.4 / 0.4 / 0.2 weights', () => {
    expect(BALANCED_WEIGHTS).toEqual({ average: 0.4, max: 0.4, stdDev: 0.2 });
    // Worked example from ENGINE.md: 0.4*20 + 0.4*30 + 0.2*8.1649658 = 21.632993...
    expect(scoreCandidate([10, 20, 30], 'balanced')).toBeCloseTo(21.632993, 4);
    // Equal durations: stddev 0, balanced = 0.8 * value.
    expect(scoreCandidate([20, 20, 20], 'balanced')).toBeCloseTo(16, 9);
  });

  it('prefers fairer distributions under minimax and balanced, cheaper totals under minTotal', () => {
    // A: total 60, max 30. B: total 66, max 22. minTotal prefers A; minimax prefers B.
    expect(scoreCandidate([10, 20, 30], 'minTotal')).toBeLessThan(scoreCandidate([22, 22, 22], 'minTotal'));
    expect(scoreCandidate([22, 22, 22], 'minimax')).toBeLessThan(scoreCandidate([10, 20, 30], 'minimax'));
    // Balanced: A=21.63, B=0.4*22+0.4*22+0=17.6 -> B wins.
    expect(scoreCandidate([22, 22, 22], 'balanced')).toBeLessThan(scoreCandidate([10, 20, 30], 'balanced'));
  });
});
