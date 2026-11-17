import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP_STYLE_URL,
  DEFAULT_OSRM_BASE_URL,
  DEFAULT_RASTER_FALLBACK_URL,
  getMapConfig,
  mapConfigWarnings,
  parseMapConfig,
  resetMapConfigCache,
} from '../../src/map/config';

describe('map config defaults', () => {
  it('works with zero env vars: OpenFreeMap style + mock routing', () => {
    const config = parseMapConfig({});
    expect(config.styleUrl).toBe(DEFAULT_MAP_STYLE_URL);
    expect(config.styleUrl).toBe('https://tiles.openfreemap.org/styles/liberty');
    expect(config.rasterFallbackUrl).toBe(DEFAULT_RASTER_FALLBACK_URL);
    expect(config.osrmBaseUrl).toBe(DEFAULT_OSRM_BASE_URL);
    expect(config.routingProvider).toBe('mock');
    expect(config.routingEnabled).toBe(true);
    expect(config.map3dEnabled).toBe(true);
    expect(config.osrmMinIntervalMs).toBe(1100);
    expect(config.osrmTimeoutMs).toBe(10_000);
    expect(config.osrmCacheTtlMs).toBe(600_000);
  });

  it('getMapConfig parses the real env and caches the result', () => {
    // Env-independent: the developer's .env may set live providers, so
    // assert consistency with parseMapConfig(import.meta.env) + caching
    // instead of hardcoded defaults (defaults are covered above).
    resetMapConfigCache();
    const config = getMapConfig();
    expect(config).toEqual(parseMapConfig((import.meta.env ?? {}) as Record<string, string | undefined>));
    expect(getMapConfig()).toBe(config);
    resetMapConfigCache();
  });
});

describe('map config overrides', () => {
  it('honours explicit env values', () => {
    const config = parseMapConfig({
      VITE_MAP_STYLE_URL: 'https://tiles.example.com/styles/custom',
      VITE_MAP_RASTER_FALLBACK_URL: 'https://tiles.example.com/{z}/{x}/{y}.png',
      VITE_OSRM_BASE_URL: 'https://osrm.example.com/',
      VITE_ROUTING_PROVIDER: 'osrm',
      VITE_ROUTING_ENABLED: 'false',
      VITE_MAP_3D_ENABLED: 'false',
      VITE_OSRM_MIN_INTERVAL_MS: '2000',
      VITE_OSRM_TIMEOUT_MS: '5000',
      VITE_OSRM_CACHE_TTL_MS: '60000',
    });
    expect(config.styleUrl).toBe('https://tiles.example.com/styles/custom');
    expect(config.rasterFallbackUrl).toBe('https://tiles.example.com/{z}/{x}/{y}.png');
    expect(config.osrmBaseUrl).toBe('https://osrm.example.com');
    expect(config.routingProvider).toBe('osrm');
    expect(config.routingEnabled).toBe(false);
    expect(config.map3dEnabled).toBe(false);
    expect(config.osrmMinIntervalMs).toBe(2000);
    expect(config.osrmTimeoutMs).toBe(5000);
    expect(config.osrmCacheTtlMs).toBe(60_000);
  });

  it('accepts off/mock providers and yes/no booleans', () => {
    expect(parseMapConfig({ VITE_ROUTING_PROVIDER: 'OFF' }).routingProvider).toBe('off');
    expect(parseMapConfig({ VITE_ROUTING_PROVIDER: 'Mock' }).routingProvider).toBe('mock');
    expect(parseMapConfig({ VITE_ROUTING_ENABLED: 'yes' }).routingEnabled).toBe(true);
    expect(parseMapConfig({ VITE_ROUTING_ENABLED: '0' }).routingEnabled).toBe(false);
  });

  it('falls back to defaults for invalid values', () => {
    const config = parseMapConfig({
      VITE_MAP_STYLE_URL: 'ftp://example.com/style.json',
      VITE_OSRM_BASE_URL: 'not-a-url',
      VITE_ROUTING_PROVIDER: 'valhalla',
      VITE_ROUTING_ENABLED: 'maybe',
      VITE_OSRM_MIN_INTERVAL_MS: 'banana',
      VITE_OSRM_TIMEOUT_MS: '',
    });
    expect(config.styleUrl).toBe(DEFAULT_MAP_STYLE_URL);
    expect(config.osrmBaseUrl).toBe(DEFAULT_OSRM_BASE_URL);
    expect(config.routingProvider).toBe('mock');
    expect(config.routingEnabled).toBe(true);
    expect(config.osrmMinIntervalMs).toBe(1100);
    expect(config.osrmTimeoutMs).toBe(10_000);
  });

  it('clamps numeric values into safe ranges', () => {
    expect(parseMapConfig({ VITE_OSRM_MIN_INTERVAL_MS: '99999' }).osrmMinIntervalMs).toBe(10_000);
    // Against the default demo server the gap floor is 1000ms: a typo
    // must never disable throttling there.
    expect(parseMapConfig({ VITE_OSRM_MIN_INTERVAL_MS: '-5' }).osrmMinIntervalMs).toBe(1000);
    expect(parseMapConfig({ VITE_OSRM_MIN_INTERVAL_MS: '0' }).osrmMinIntervalMs).toBe(1000);
    // A custom (self-hosted) server may opt into a lower gap.
    expect(
      parseMapConfig({ VITE_OSRM_BASE_URL: 'https://osrm.example.com', VITE_OSRM_MIN_INTERVAL_MS: '0' })
        .osrmMinIntervalMs,
    ).toBe(0);
    expect(parseMapConfig({ VITE_OSRM_TIMEOUT_MS: '5' }).osrmTimeoutMs).toBe(1000);
    expect(parseMapConfig({ VITE_OSRM_TIMEOUT_MS: '999999' }).osrmTimeoutMs).toBe(60_000);
  });

  it('trims whitespace and strips multiple trailing slashes from the OSRM base URL', () => {
    const config = parseMapConfig({ VITE_OSRM_BASE_URL: '  https://osrm.example.com///  ' });
    expect(config.osrmBaseUrl).toBe('https://osrm.example.com');
  });

  it('documents TTL 0 as never-expire', () => {
    expect(parseMapConfig({ VITE_OSRM_CACHE_TTL_MS: '0' }).osrmCacheTtlMs).toBe(0);
  });
});

describe('mapConfigWarnings', () => {
  it('is silent for valid values and empty env', () => {
    expect(mapConfigWarnings({})).toEqual([]);
    expect(
      mapConfigWarnings({ VITE_ROUTING_PROVIDER: 'osrm', VITE_OSRM_BASE_URL: 'https://osrm.example.com' }),
    ).toEqual([]);
  });

  it('warns on bad URLs, unknown providers and non-numeric ints', () => {
    const warnings = mapConfigWarnings({
      VITE_OSRM_BASE_URL: 'not-a-url',
      VITE_ROUTING_PROVIDER: 'valhalla',
      VITE_OSRM_TIMEOUT_MS: 'banana',
    });
    expect(warnings.join(' ')).toMatch(/VITE_OSRM_BASE_URL/);
    expect(warnings.join(' ')).toMatch(/VITE_ROUTING_PROVIDER/);
    expect(warnings.join(' ')).toMatch(/VITE_OSRM_TIMEOUT_MS/);
  });
});
