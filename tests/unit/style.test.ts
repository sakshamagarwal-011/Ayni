import { describe, expect, it } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import { buildBuildingsLayer, buildRasterFallbackStyle, findBuildingSource } from '../../src/map/style';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

describe('raster fallback style', () => {
  it('is a valid v8 style with an OSM raster source capped at zoom 19', () => {
    const style = buildRasterFallbackStyle(TILE_URL);
    expect(style.version).toBe(8);
    const source = style.sources.osm;
    expect(source.type).toBe('raster');
    if (source.type === 'raster') {
      expect(source.tiles).toEqual([TILE_URL]);
      expect(source.maxzoom).toBe(19);
      expect(source.attribution).toContain('OpenStreetMap');
    }
    expect(style.layers.map((l) => l.id)).toEqual(['background', 'osm-tiles']);
  });
});

describe('findBuildingSource', () => {
  it('finds a vector source with a building source-layer', () => {
    const style = {
      version: 8,
      sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
      layers: [
        { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
        { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building' },
      ],
    } as unknown as StyleSpecification;
    expect(findBuildingSource(style)).toEqual({ sourceId: 'openmaptiles', sourceLayer: 'building' });
  });

  it('returns null when no layer references buildings', () => {
    const style = {
      version: 8,
      sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
      layers: [{ id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' }],
    } as unknown as StyleSpecification;
    expect(findBuildingSource(style)).toBeNull();
  });

  it('returns null for the raster fallback style', () => {
    expect(findBuildingSource(buildRasterFallbackStyle(TILE_URL))).toBeNull();
  });
});

describe('buildings layer', () => {
  it('builds a fill-extrusion layer for the detected source', () => {
    const layer = buildBuildingsLayer({ sourceId: 'openmaptiles', sourceLayer: 'building' });
    expect(layer.id).toBe('meetsync-3d-buildings');
    expect(layer.type).toBe('fill-extrusion');
    expect(layer.source).toBe('openmaptiles');
    expect(layer['source-layer']).toBe('building');
    expect(layer.minzoom).toBe(14);
    expect(layer.paint?.['fill-extrusion-height']).toBeDefined();
    expect(layer.paint?.['fill-extrusion-base']).toBeDefined();
  });
});
