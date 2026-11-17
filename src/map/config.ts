/**
 * Map + routing provider configuration.
 *
 * Single place where every map/routing provider choice lives. All values
 * are env-driven with safe development defaults, so the app works with
 * ZERO new env vars: the default vector style (OpenFreeMap Liberty) and
 * mock/demo routing. Live OSRM routing is opt-in via
 * VITE_ROUTING_PROVIDER=osrm.
 *
 * Pure parsing (parseMapConfig) is unit-testable: pass an env record in,
 * no window/import.meta access inside the parser.
 *
 * See MAPS.md for provider usage policies and production guidance.
 */

export type RoutingProvider = 'osrm' | 'mock' | 'off';

export interface MapConfig {
  /** MapLibre style URL (vector style JSON) or style document URL. */
  styleUrl: string;
  /** Raster tile URL template used only when the vector style fails. */
  rasterFallbackUrl: string;
  /** OSRM server base URL (no trailing slash). Public demo server by default. */
  osrmBaseUrl: string;
  /** Which routing backend to use. 'mock' = deterministic demo estimates. */
  routingProvider: RoutingProvider;
  /** Master switch: false disables route lines entirely (markers only). */
  routingEnabled: boolean;
  /** Whether 3D building extrusion is attempted where the style supports it. */
  map3dEnabled: boolean;
  /** Minimum gap between OSRM requests (ms). Demo-server policy: max 1 req/s. */
  osrmMinIntervalMs: number;
  /** Per-request OSRM timeout (ms). */
  osrmTimeoutMs: number;
  /** In-memory OSRM response cache TTL (ms). */
  osrmCacheTtlMs: number;
}

/**
 * Default vector style: OpenFreeMap Liberty.
 * OpenStreetMap-based vector tiles (OpenMapTiles schema), no account, no
 * API key, no published request cap. Donation-funded with no uptime
 * guarantee — see MAPS.md. Verified live 2026-11-17: the style JSON loads
 * and declares the `openmaptiles` vector source used for 3D buildings.
 *
 * Why not CARTO Dark Matter: since Aug/Sep 2026 CARTO basemaps used
 * outside the CARTO platform require a free API key, and keyless tiles
 * are watermarked — incompatible with the zero-key dev default.
 */
export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Raster fallback, used ONLY if the vector style fails to load.
 * Standard OpenStreetMap raster tiles: light use only, under the OSM
 * Tile Usage Policy (no heavy use, no bulk downloading). This fallback
 * exists so a failed style never leaves the user with no map at all;
 * for production, point VITE_MAP_STYLE_URL / VITE_MAP_RASTER_FALLBACK_URL
 * at your own tile service. Attribution is always shown.
 */
export const DEFAULT_RASTER_FALLBACK_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * OSRM public demo server (FOSSGIS-sponsored). Development only:
 * reasonable, non-commercial use, max 1 request/second, no uptime
 * guarantee. Self-host for anything beyond light development use.
 */
export const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';

export const DEFAULT_MAP_CONFIG: MapConfig = {
  styleUrl: DEFAULT_MAP_STYLE_URL,
  rasterFallbackUrl: DEFAULT_RASTER_FALLBACK_URL,
  osrmBaseUrl: DEFAULT_OSRM_BASE_URL,
  routingProvider: 'mock',
  routingEnabled: true,
  map3dEnabled: true,
  osrmMinIntervalMs: 1100,
  osrmTimeoutMs: 10000,
  osrmCacheTtlMs: 600_000,
};

function asHttpUrl(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim();
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  return fallback;
}

function asProvider(raw: string | undefined): RoutingProvider {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'osrm' || value === 'mock' || value === 'off') return value;
  return DEFAULT_MAP_CONFIG.routingProvider;
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

export function parseMapConfig(env: Record<string, string | undefined>): MapConfig {
  const osrmBaseUrl = asHttpUrl(env.VITE_OSRM_BASE_URL, DEFAULT_MAP_CONFIG.osrmBaseUrl).replace(/\/+$/, '');
  // Floor the request gap at 1000ms against the public demo server: a
  // typo must never disable throttling there. Operators pointing at
  // their OWN server may set a lower gap deliberately.
  const minIntervalFloor = osrmBaseUrl === DEFAULT_OSRM_BASE_URL ? 1000 : 0;
  return {
    styleUrl: asHttpUrl(env.VITE_MAP_STYLE_URL, DEFAULT_MAP_CONFIG.styleUrl),
    rasterFallbackUrl: asHttpUrl(env.VITE_MAP_RASTER_FALLBACK_URL, DEFAULT_MAP_CONFIG.rasterFallbackUrl),
    osrmBaseUrl,
    routingProvider: asProvider(env.VITE_ROUTING_PROVIDER),
    routingEnabled: asBool(env.VITE_ROUTING_ENABLED, DEFAULT_MAP_CONFIG.routingEnabled),
    map3dEnabled: asBool(env.VITE_MAP_3D_ENABLED, DEFAULT_MAP_CONFIG.map3dEnabled),
    osrmMinIntervalMs: asClampedInt(
      env.VITE_OSRM_MIN_INTERVAL_MS,
      DEFAULT_MAP_CONFIG.osrmMinIntervalMs,
      minIntervalFloor,
      10_000,
    ),
    osrmTimeoutMs: asClampedInt(env.VITE_OSRM_TIMEOUT_MS, DEFAULT_MAP_CONFIG.osrmTimeoutMs, 1000, 60_000),
    // TTL 0 means "never expire" (see routing.ts cached()). Documented
    // in MAPS.md; only set it deliberately.
    osrmCacheTtlMs: asClampedInt(env.VITE_OSRM_CACHE_TTL_MS, DEFAULT_MAP_CONFIG.osrmCacheTtlMs, 0, 3_600_000),
  };
}

/**
 * Dev warnings for invalid map/routing env values. parseMapConfig
 * silently falls back on bad input (a typo'd base URL would otherwise
 * quietly point at the public demo server); getMapConfig surfaces
 * these in development so misconfiguration is visible.
 */
export function mapConfigWarnings(env: Record<string, string | undefined>): string[] {
  const warnings: string[] = [];
  const checkUrl = (key: string) => {
    const raw = env[key];
    if (raw !== undefined && raw.trim() !== '' && !raw.trim().startsWith('http://') && !raw.trim().startsWith('https://')) {
      warnings.push(`${key} is not an http(s) URL ("${raw}"); the default is used.`);
    }
  };
  checkUrl('VITE_MAP_STYLE_URL');
  checkUrl('VITE_MAP_RASTER_FALLBACK_URL');
  checkUrl('VITE_OSRM_BASE_URL');
  const provider = env.VITE_ROUTING_PROVIDER;
  if (provider !== undefined && provider.trim() !== '' && !['osrm', 'mock', 'off'].includes(provider.trim().toLowerCase())) {
    warnings.push(`VITE_ROUTING_PROVIDER "${provider}" is not osrm/mock/off; falling back to "mock".`);
  }
  const checkInt = (key: string) => {
    const raw = env[key];
    if (raw !== undefined && raw.trim() !== '' && !Number.isFinite(Number.parseInt(raw.trim(), 10))) {
      warnings.push(`${key} "${raw}" is not a number; the default is used.`);
    }
  };
  checkInt('VITE_OSRM_MIN_INTERVAL_MS');
  checkInt('VITE_OSRM_TIMEOUT_MS');
  checkInt('VITE_OSRM_CACHE_TTL_MS');
  return warnings;
}

let cached: MapConfig | null = null;

/** Runtime config from Vite env vars (build-time constants). Cached. */
export function getMapConfig(): MapConfig {
  if (cached) return cached;
  const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
  cached = parseMapConfig(env);
  if (typeof import.meta.env?.DEV === 'boolean' && import.meta.env.DEV) {
    for (const warning of mapConfigWarnings(env)) {
      console.warn(`[MeetSync map config] ${warning}`);
    }
  }
  return cached;
}

/** Test/refresh helper: drop the cached config so the next read re-parses. */
export function resetMapConfigCache(): void {
  cached = null;
}
