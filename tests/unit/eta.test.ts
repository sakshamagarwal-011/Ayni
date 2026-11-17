import { describe, expect, it } from 'vitest';
import { etaClockTime, etaLabel, formatEtaTime, latestEtaLabel } from '../../src/coordination/eta';

// Fixed "now": 2026-11-17 18:00 local time, constructed from local
// components so the test is timezone-independent.
const NOW = new Date(2026, 10, 17, 18, 0, 0);

describe('etaClockTime', () => {
  it('adds the duration in minutes', () => {
    const eta = etaClockTime(24, NOW);
    expect(eta.getHours()).toBe(18);
    expect(eta.getMinutes()).toBe(24);
  });
  it('rolls over the hour', () => {
    const eta = etaClockTime(75, NOW);
    expect(eta.getHours()).toBe(19);
    expect(eta.getMinutes()).toBe(15);
  });
  it('clamps negative durations to now', () => {
    expect(etaClockTime(-10, NOW).getTime()).toBe(NOW.getTime());
  });
  it('handles zero duration', () => {
    expect(etaClockTime(0, NOW).getTime()).toBe(NOW.getTime());
  });
});

describe('formatEtaTime / etaLabel', () => {
  it('formats a clock time with hour and minute', () => {
    const label = formatEtaTime(new Date(2026, 10, 17, 18, 42, 0));
    expect(label).toMatch(/18:42|6:42/);
  });
  it('labels the ETA as "if leaving now" with the duration', () => {
    const label = etaLabel(24, NOW);
    expect(label).toContain('if leaving now');
    expect(label).toContain('24 min');
    expect(label).toMatch(/18:24|6:24/);
  });
});

describe('latestEtaLabel', () => {
  it('returns null for an empty list', () => {
    expect(latestEtaLabel([], NOW)).toBeNull();
  });
  it('uses the longest duration', () => {
    const label = latestEtaLabel([10, 45, 20], NOW);
    expect(label).toContain('45 min');
    expect(label).toMatch(/18:45|6:45/);
  });
});
