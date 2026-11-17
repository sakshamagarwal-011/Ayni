import { describe, expect, it } from 'vitest';
import { animationDurationMs, midpointOf, polylineLengthM, progressGeometry, simplifyGeometry } from '../../src/engine/animation';

// A straight eastward line at the equator: 0.01° lng ≈ 1112 m per segment.
const LINE = [
  [0, 0],
  [0.01, 0],
  [0.02, 0],
  [0.03, 0],
];

describe('progressGeometry', () => {
  it('returns [] for empty and a copy for a single point', () => {
    expect(progressGeometry([], 0.5)).toEqual([]);
    expect(progressGeometry([[1, 2]], 0.5)).toEqual([[1, 2]]);
  });

  it('returns a degenerate start line at 0 and the full line at 1', () => {
    expect(progressGeometry(LINE, 0)).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(progressGeometry(LINE, 1)).toEqual(LINE);
    expect(progressGeometry(LINE, 1)).not.toBe(LINE);
  });

  it('interpolates along the line by segment length at 0.5', () => {
    // Half of the total length lands exactly on the middle vertex (0.015°).
    const half = progressGeometry(LINE, 0.5);
    expect(half).toHaveLength(3);
    expect(half[2][0]).toBeCloseTo(0.015, 6);
    expect(half[2][1]).toBe(0);
  });

  it('interpolates inside a segment at 0.25', () => {
    const quarter = progressGeometry(LINE, 0.25);
    expect(quarter).toHaveLength(2);
    expect(quarter[1][0]).toBeCloseTo(0.0075, 6);
  });

  it('clamps progress to [0, 1]', () => {
    expect(progressGeometry(LINE, -5)).toEqual(progressGeometry(LINE, 0));
    expect(progressGeometry(LINE, 99)).toEqual(LINE);
  });

  it('handles 2-point lines', () => {
    const two = progressGeometry(
      [
        [0, 0],
        [0.02, 0],
      ],
      0.5,
    );
    expect(two).toHaveLength(2);
    expect(two[1][0]).toBeCloseTo(0.01, 6);
  });

  it('handles zero-length lines without NaN', () => {
    const flat = progressGeometry(
      [
        [1, 1],
        [1, 1],
        [1, 1],
      ],
      0.5,
    );
    expect(flat.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
  });
});

describe('simplifyGeometry', () => {
  it('returns a copy when already short enough', () => {
    expect(simplifyGeometry(LINE, 10)).toEqual(LINE);
  });

  it('decimates evenly and preserves endpoints', () => {
    const long = Array.from({ length: 101 }, (_, i) => [i, 0]);
    const simplified = simplifyGeometry(long, 11);
    expect(simplified).toHaveLength(11);
    expect(simplified[0]).toEqual([0, 0]);
    expect(simplified[10]).toEqual([100, 0]);
    expect(simplified[5]).toEqual([50, 0]);
  });

  it('handles maxPoints < 2', () => {
    expect(simplifyGeometry(LINE, 1)).toEqual([[0, 0]]);
    expect(simplifyGeometry([], 5)).toEqual([]);
  });
});

describe('animationDurationMs', () => {
  it('scales with length and speed, clamped to [1200, 10000]', () => {
    expect(animationDurationMs(0)).toBe(1200);
    expect(animationDurationMs(1000, 1)).toBe(1500);
    expect(animationDurationMs(1000, 2)).toBe(1200); // 750ms clamped up
    expect(animationDurationMs(4000, 1)).toBe(6000);
    expect(animationDurationMs(100_000, 1)).toBe(10_000);
    expect(animationDurationMs(2000, 0)).toBe(3000); // invalid speed -> 1x
  });
});

describe('polylineLengthM / midpointOf', () => {
  it('measures length and midpoint', () => {
    expect(polylineLengthM(LINE)).toBeCloseTo(3336, 0);
    expect(polylineLengthM([])).toBe(0);
    expect(midpointOf(LINE)).toEqual([0.02, 0]);
    expect(midpointOf([])).toBeNull();
  });
});
