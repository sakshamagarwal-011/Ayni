import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_PHOTON_URL,
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
    expect(DEFAULT_ENGINE_CONFIG.photonUrl).toBe('https://photon.komoot.io');
    expect(DEFAULT_PHOTON_URL).toBe('https://photon.komoot.io');
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

  it('parses the proxy places provider (case-insensitive)', () => {
    expect(parseEngineConfig({ VITE_PLACES_PROVIDER: 'proxy' }).placesProvider).toBe('proxy');
    expect(parseEngineConfig({ VITE_PLACES_PROVIDER: 'Proxy' }).placesProvider).toBe('proxy');
  });

  it('parses the photon places provider (case-insensitive) and its URL override', () => {
    expect(parseEngineConfig({ VITE_PLACES_PROVIDER: 'photon' }).placesProvider).toBe('photon');
    expect(parseEngineConfig({ VITE_PLACES_PROVIDER: 'Photon' }).placesProvider).toBe('photon');
    const config = parseEngineConfig({
      VITE_PLACES_PROVIDER: 'photon',
      VITE_PHOTON_URL: 'https://photon.example.org/',
    });
    expect(config.photonUrl).toBe('https://photon.example.org');
  });

  it('falls back to the default Photon URL on an invalid override', () => {
    const config = parseEngineConfig({ VITE_PHOTON_URL: 'not-a-url' });
    expect(config.photonUrl).toBe(DEFAULT_ENGINE_CONFIG.photonUrl);
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

  it('is live for the proxy provider with OSRM routing, with a proxy-specific reason', () => {
    const resolved = resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'proxy' }, 'osrm', true);
    expect(resolved.mode).toBe('live');
    expect(resolved.reason).toBe('Live search: places via the Supabase proxy + OSRM road routing.');
    expect(
      resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'overpass' }, 'osrm', true).reason,
    ).toBe('Live search: Overpass places + OSRM road routing.');
  });

  it('is live for the photon provider with OSRM routing, with a photon-specific reason', () => {
    const resolved = resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'photon' }, 'osrm', true);
    expect(resolved.mode).toBe('live');
    expect(resolved.reason).toBe('Live search: Photon places + OSRM road routing.');
  });

  it('falls back to demo for photon with mock routing, never mixing labels', () => {
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'photon' }, 'mock', true).mode).toBe('demo');
  });

  it('falls back to demo on mixed configs, never mixing labels', () => {
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'overpass' }, 'mock', true).mode).toBe('demo');
    expect(resolveEngineMode(DEFAULT_ENGINE_CONFIG, 'osrm', true).mode).toBe('demo');
  });

  it('is disabled when the engine, places, or routing is off', () => {
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, enabled: false }, 'osrm', true).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'off' }, 'osrm', true).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'overpass' }, 'off', true).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'proxy' }, 'off', true).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'proxy' }, 'osrm', false).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'overpass' }, 'osrm', false).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'photon' }, 'off', true).mode).toBe('disabled');
    expect(resolveEngineMode({ ...DEFAULT_ENGINE_CONFIG, placesProvider: 'photon' }, 'osrm', false).mode).toBe('disabled');
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
