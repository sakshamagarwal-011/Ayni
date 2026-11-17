import { describe, expect, it } from 'vitest';
import { GEOLOCATION_OPTIONS, geolocationErrorMessage } from '../../src/map/useGeolocation';

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
