import type { FillExtrusionLayerSpecification, StyleSpecification } from 'maplibre-gl';

/**
 * MapLibre style helpers. Type-only MapLibre import: no runtime map
 * dependency, so this module is safe to unit-test in Node.
 */

/** Attribution text that must stay visible on every map, vector or raster. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OPENFREEMAP_ATTRIBUTION = '© OpenMapTiles © OpenStreetMap contributors';

/**
 * Built-in raster fallback style (OSM standard tiles). Used only when
 * the configured vector style fails to load. Max zoom 19 per the OSM
 * Tile Usage Policy; light use only — see MAPS.md.
 */
export function buildRasterFallbackStyle(tileUrl: string): StyleSpecification {
  return {
    version: 8,
    name: 'MeetSync raster fallback (OpenStreetMap)',
    sources: {
      osm: {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        maxzoom: 19,
        attribution: OSM_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#070b1a' } },
      { id: 'osm-tiles', type: 'raster', source: 'osm' },
    ],
  };
}

export interface BuildingSource {
  sourceId: string;
  sourceLayer: string;
}

/**
 * Find a vector source + source-layer that carries building footprints,
 * by scanning the loaded style for a layer already referencing a
 * 'building' source-layer (the OpenMapTiles schema name used by
 * OpenFreeMap). Returns null when the style has no building data
 * (e.g. the raster fallback) — callers must then disable 3D gracefully.
 */
export function findBuildingSource(style: StyleSpecification): BuildingSource | null {
  for (const layer of style.layers) {
    if ('source-layer' in layer && layer['source-layer'] === 'building' && 'source' in layer) {
      const sourceId = layer.source;
      if (typeof sourceId === 'string') return { sourceId, sourceLayer: 'building' };
    }
  }
  return null;
}

/**
 * Immersive 3D capability check (pure, unit-testable). Immersive mode
 * (pitched camera + building extrusion + slight bearing) requires
 * WebGL and a vector style with building data, and must not be
 * auto-applied when the map fell back to raster tiles. Reduced motion
 * does not disable 3D rendering itself — it only disables automatic
 * camera movement (the map starts pitched, without a fly-to).
 */
export interface Immersive3DInput {
  webglSupported: boolean;
  buildingsAvailable: 'unknown' | 'yes' | 'no';
  usingRasterFallback: boolean;
  map3dEnabled: boolean;
}

export interface Immersive3DResult {
  supported: boolean;
  reason: string;
}

export function canUseImmersive3D(input: Immersive3DInput): Immersive3DResult {
  if (!input.webglSupported) {
    return { supported: false, reason: 'WebGL is not available on this device.' };
  }
  if (!input.map3dEnabled) {
    return { supported: false, reason: '3D mode is disabled in settings.' };
  }
  if (input.usingRasterFallback) {
    return { supported: false, reason: '3D is unavailable with the raster fallback map.' };
  }
  if (input.buildingsAvailable === 'no') {
    return { supported: false, reason: '3D buildings are not available for this map style.' };
  }
  if (input.buildingsAvailable === 'unknown') {
    return { supported: false, reason: 'Checking whether 3D buildings are available…' };
  }
  return { supported: true, reason: 'Immersive 3D is available.' };
}

/**
 * Fill-extrusion layer spec for 3D buildings. Heights come from the
 * OpenMapTiles `render_height` / `render_min_height` properties, with
 * fallbacks to `height` / `min_height` and a 10m default. Opacity ramps
 * in with zoom so buildings fade in instead of popping. Insert before
 * the first symbol layer so labels stay on top (the component handles
 * placement); the spec itself is pure and unit-testable.
 */
export function buildBuildingsLayer(source: BuildingSource): FillExtrusionLayerSpecification {
  return {
    id: 'meetsync-3d-buildings',
    type: 'fill-extrusion',
    source: source.sourceId,
    'source-layer': source.sourceLayer,
    filter: ['==', ['geometry-type'], 'Polygon'],
    minzoom: 14,
    paint: {
      'fill-extrusion-color': '#8b9cc9',
      'fill-extrusion-height': [
        'interpolate',
        ['linear'],
        ['zoom'],
        14,
        0,
        14.05,
        ['coalesce', ['get', 'render_height'], ['get', 'height'], 10],
      ],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
      'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.55],
    },
  };
}
