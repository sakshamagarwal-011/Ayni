import { describe, expect, it } from 'vitest';
import {
  GEOLOCATION_OPTIONS,
  assessGeolocationFix,
  geolocationErrorMessage,
} from '../../src/map/useGeolocation';

describe('geolocation error messages', () => {
  it('explains permission denial with a fallback', () => {
    const message = geolocationErrorMessage(1);
    expect(message).toMatch(/denied/i);
    expect(message).toMatch(/pick a point on the map/i);
  });

  it('explains position unavailable', () => {
    expect(geolocationErrorMessage(2)).toMatch(/could not determine/i);
  });

  it('explains timeout', () => {
    expect(geolocationErrorMessage(3)).toMatch(/timed out/i);
  });

  it('falls back to a generic unavailable message for unknown codes', () => {
    expect(geolocationErrorMessage(null)).toMatch(/unavailable/i);
    expect(geolocationErrorMessage(99)).toMatch(/unavailable/i);
  });
});

describe('geolocation options', () => {
  it('requests high accuracy with a 10s timeout and 30s cache', () => {
    expect(GEOLOCATION_OPTIONS.enableHighAccuracy).toBe(true);
    expect(GEOLOCATION_OPTIONS.timeout).toBe(10_000);
    expect(GEOLOCATION_OPTIONS.maximumAge).toBe(30_000);
  });
});

describe('assessGeolocationFix', () => {
  const NOW = 1_700_000_000_000;
  const base = { coords: { lat: 12.97, lng: 77.64 }, accuracyM: 15, timestamp: NOW };
  it('accepts a fresh, accurate fix without a warning', () => {
    const quality = assessGeolocationFix(base, NOW);
    expect(quality.degraded).toBe(false);
    expect(quality.warning).toBeNull();
  });
  it('warns on low accuracy (>100 m)', () => {
    const quality = assessGeolocationFix({ ...base, accuracyM: 1500 }, NOW);
    expect(quality.degraded).toBe(true);
    expect(quality.lowAccuracy).toBe(true);
    expect(quality.warning).toMatch(/1500 m/);
  });
  it('warns on a stale fix (>60 s old)', () => {
    const quality = assessGeolocationFix({ ...base, timestamp: NOW - 61_000 }, NOW);
    expect(quality.degraded).toBe(true);
    expect(quality.staleFix).toBe(true);
    expect(quality.warning).toMatch(/over a minute old/);
  });
  it('treats unknown accuracy as usable', () => {
    expect(assessGeolocationFix({ ...base, accuracyM: null }, NOW).degraded).toBe(false);
  });
});
