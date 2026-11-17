import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGINE_CONFIG,
  getEngineConfig,
  parseEngineConfig,
  resetEngineConfigCache,
  resolveEngineMode,
} from '../../src/engine/config';

describe('parseEngineConfig', () => {
  it('uses safe defaults with an empty env', () => {
    expect(parseEngineConfig({})).toEqual(DEFAULT_ENGINE_CONFIG);
    expect(DEFAULT_ENGINE_CONFIG.placesProvider).toBe('mock');
    expect(DEFAULT_ENGINE_CONFIG.maxCandidates).toBe(12);
    expect(DEFAULT_ENGINE_CONFIG.maxOsrmRequests).toBe(60);
    // Weak public mirrors need more patience than the old 25s default.
    expect(DEFAULT_ENGINE_CONFIG.overpassTimeoutMs).toBe(45_000);
  });

  it('parses valid overrides', () => {
    const config = parseEngineConfig({
      VITE_PLACES_PROVIDER: 'overpass',
      VITE_OVERPASS_URL: 'https://overpass.private.example/api/',
      VITE_OVERPASS_TIMEOUT_MS: '5000',
      VITE_OPTIMIZATION_MAX_CANDIDATES: '8',
      VITE_OPTIMIZATION_MAX_OSRM_REQUESTS: '40',
      VITE_OPTIMIZATION_ENABLED: 'false',
    });
    expect(config.placesProvider).toBe('overpass');
    expect(config.overpassUrl).toBe('https://overpass.private.example/api');
    expect(config.overpassTimeoutMs).toBe(5000);
    expect(config.maxCandidates).toBe(8);
    expect(config.maxOsrmRequests).toBe(40);
    expect(config.enabled).toBe(false);
  });

  it('falls back to defaults on invalid values and clamps ranges', () => {
    const config = parseEngineConfig({
      VITE_PLACES_PROVIDER: 'proprietary',
      VITE_OVERPASS_URL: 'not-a-url',
      VITE_OPTIMIZATION_MAX_CANDIDATES: '99',
      VITE_OPTIMIZATION_MAX_OSRM_REQUESTS: '0',
    });
    expect(config.placesProvider).toBe('mock');
    expect(config.overpassUrl).toBe(DEFAULT_ENGINE_CONFIG.overpassUrl);
    expect(config.maxCandidates).toBe(20);
    expect(config.maxOsrmRequests).toBe(1);
  });
});

describe('resolveEngineMode', () => {
  it('is live only when both places and routing are live', () => {
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'overpass' }, 'osrm', true).mode).toBe('live');
  });

  it('falls back to demo on mixed configs, never mixing labels', () => {
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'overpass' }, 'mock', true).mode).toBe('demo');
    expect(resolveEngineMode(DEFAULT_ENGINE_CONFIG, 'osrm', true).mode).toBe('demo');
  });

  it('is disabled when the engine, places, or routing is off', () => {
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, enabled: false }, 'osrm', true).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'off' }, 'osrm', true).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'overpass' }, 'off', true).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'overpass' }, 'osrm', false).mode).toBe('disabled');
  });
});

describe('getEngineConfig', () => {
  it('reads from import.meta.env and caches', () => {
    // Env-independent: the developer's .env may set live providers, so
    // assert consistency with parseEngineConfig(import.meta.env) +
    // caching instead of hardcoded defaults (covered above).
    resetEngineConfigCache();
    const config = getEngineConfig();
    expect(config).toEqual(parseEngineConfig((import.meta.env ?? {}) as Record<string, string | undefined>));
    expect(getEngineConfig()).toBe(config);
    resetEngineConfigCache();
  });
});
