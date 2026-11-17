import type { RoutingProvider } from '../map/config';

/**
 * Optimization-engine configuration. Kept separate from
 * src/map/config.ts so the engine's provider/budget choices have one
 * home; the two configs are combined by resolveEngineMode().
 *
 * Defaults are fully safe: mock places + mock routing, zero external
 * calls without opt-in — matching the Phase 3 safety posture.
 * Pure parser (unit-testable), mirroring parseMapConfig's style.
 */

export type PlacesProvider = 'overpass' | 'proxy' | 'photon' | 'mock' | 'off';

export interface EngineConfig {
  enabled: boolean;
  placesProvider: PlacesProvider;
  overpassUrl: string;
  overpassTimeoutMs: number;
  photonUrl: string;
  /** Max candidates carried from discovery into routing (after pre-filter). Hard cap 20. */
  maxCandidates: number;
  /** Max unique route pairs per optimization run. Exceeding this aborts with a clear error. */
  maxOsrmRequests: number;
  /** Max places requested per Overpass search area. */
  placesPerArea: number;
}

export const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

export const DEFAULT_PHOTON_URL = 'https://photon.komoot.io';

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  enabled: true,
  placesProvider: 'mock',
  overpassUrl: DEFAULT_OVERPASS_URL,
  overpassTimeoutMs: 45_000,
  photonUrl: DEFAULT_PHOTON_URL,
  maxCandidates: 12,
  maxOsrmRequests: 60,
  placesPerArea: 30,
};

function asHttpUrl(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim();
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  return fallback;
}

function asPlacesProvider(raw: string | undefined): PlacesProvider {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'overpass' || value === 'proxy' || value === 'photon' || value === 'mock' || value === 'off') return value;
  return DEFAULT_ENGINE_CONFIG.placesProvider;
}

function asBool(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  return fallback;
}

function asClampedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function parseEngineConfig(env: Record<string, string | undefined>): EngineConfig {
  return {
    enabled: asBool(env.VITE_OPTIMIZATION_ENABLED, DEFAULT_ENGINE_CONFIG.enabled),
    placesProvider: asPlacesProvider(env.VITE_PLACES_PROVIDER),
    overpassUrl: asHttpUrl(env.VITE_OVERPASS_URL, DEFAULT_ENGINE_CONFIG.overpassUrl).replace(/\/+$/, ''),
    overpassTimeoutMs: asClampedInt(
      env.VITE_OVERPASS_TIMEOUT_MS,
      DEFAULT_ENGINE_CONFIG.overpassTimeoutMs,
      1000,
      60_000,
    ),
    photonUrl: asHttpUrl(env.VITE_PHOTON_URL, DEFAULT_ENGINE_CONFIG.photonUrl).replace(/\/+$/, ''),
    maxCandidates: asClampedInt(
      env.VITE_OPTIMIZATION_MAX_CANDIDATES,
      DEFAULT_ENGINE_CONFIG.maxCandidates,
      1,
      20,
    ),
    maxOsrmRequests: asClampedInt(
      env.VITE_OPTIMIZATION_MAX_OSRM_REQUESTS,
      DEFAULT_ENGINE_CONFIG.maxOsrmRequests,
      1,
      500,
    ),
    placesPerArea: asClampedInt(env.VITE_OPTIMIZATION_PLACES_PER_AREA, DEFAULT_ENGINE_CONFIG.placesPerArea, 1, 50),
  };
}

let cached: EngineConfig | null = null;

export function getEngineConfig(): EngineConfig {
  if (cached) return cached;
  const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
  cached = parseEngineConfig(env);
  return cached;
}

export function resetEngineConfigCache(): void {
  cached = null;
}

export type EngineMode = 'live' | 'demo' | 'disabled';

export interface ResolvedEngineMode {
  mode: EngineMode;
  /** Human-readable reason, shown in the UI when the mode is not live. */
  reason: string;
}

/**
 * Live mode requires BOTH live places and live routing. Mixed configs
 * fall back to the fully-labelled demo path — live places must never
 * be ranked with demo travel times, and live routes must never rank
 * mock places as if they were real. This keeps the two paths' labels
 * from ever mixing.
 */
export function resolveEngineMode(
  engine: EngineConfig,
  routingProvider: RoutingProvider,
  routingEnabled: boolean,
): ResolvedEngineMode {
  if (!engine.enabled) {
    return { mode: 'disabled', reason: 'Optimization is disabled (VITE_OPTIMIZATION_ENABLED=false).' };
  }
  if (engine.placesProvider === 'off' || routingProvider === 'off' || !routingEnabled) {
    return {
      mode: 'disabled',
      reason: 'Optimization is disabled because places or routing is turned off.',
    };
  }
  if (engine.placesProvider === 'overpass' && routingProvider === 'osrm') {
    return { mode: 'live', reason: 'Live search: Overpass places + OSRM road routing.' };
  }
  if (engine.placesProvider === 'proxy' && routingProvider === 'osrm') {
    return { mode: 'live', reason: 'Live search: places via the Supabase proxy + OSRM road routing.' };
  }
  if (engine.placesProvider === 'photon' && routingProvider === 'osrm') {
    return { mode: 'live', reason: 'Live search: Photon places + OSRM road routing.' };
  }
  return {
    mode: 'demo',
    reason:
      'Demo search: mock places + demo estimates. Enable live search with VITE_PLACES_PROVIDER=photon (or overpass/proxy) and VITE_ROUTING_PROVIDER=osrm.',
  };
}
