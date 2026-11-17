import bbox from '@turf/bbox';
import center from '@turf/center';
import { featureCollection, point } from '@turf/helpers';
import type { Coordinates, ParticipantLocation } from '../types';

/**
 * Geospatial helpers built on Turf.js. Pure functions — no map, window,
 * or network access — so they are unit-testable in Node.
 *
 * Coordinates in this app are {lat, lng}; Turf/GeoJSON use [lng, lat].
 * Every helper below converts explicitly at the boundary.
 */

export type LngLatBounds = [number, number, number, number]; // [west, south, east, north]

/** Small expansion (degrees) applied to single-point bounds so fitBounds never over-zooms. */
const SINGLE_POINT_PAD_DEG = 0.02;

function toPoints(coords: Coordinates[]) {
  return featureCollection(coords.map((c) => point([c.lng, c.lat])));
}

/**
 * Bounding box covering all points, via turf.bbox. Returns null for an
 * empty list. A single point is expanded to a small box around itself.
 */
export function boundsForPoints(coords: Coordinates[]): LngLatBounds | null {
  if (coords.length === 0) return null;
  const [west, south, east, north] = bbox(toPoints(coords));
  // Expand degenerate bounds whenever the box has zero width or height
  // — not just the single-point case: two friends on the same preset
  // (or due north/south of each other) otherwise over-zoom to maxZoom.
  if (coords.length === 1 || west === east || south === north) {
    return [
      west - SINGLE_POINT_PAD_DEG,
      south - SINGLE_POINT_PAD_DEG,
      east + SINGLE_POINT_PAD_DEG,
      north + SINGLE_POINT_PAD_DEG,
    ];
  }
  return [west, south, east, north];
}

/** Geographic centre of the points, via turf.center. Null for an empty list. */
export function centreForPoints(coords: Coordinates[]): Coordinates | null {
  if (coords.length === 0) return null;
  const c = center(toPoints(coords));
  const [lng, lat] = c.geometry.coordinates;
  return { lat, lng };
}

/** Straight-line geometry between two points, as [lng, lat] pairs (GeoJSON order). */
export function straightLineGeometry(from: Coordinates, to: Coordinates): number[][] {
  return [
    [from.lng, from.lat],
    [to.lng, to.lat],
  ];
}

/** True when a participant location has passed its expiry time. */
export function isExpired(location: Pick<ParticipantLocation, 'expiresAt'>, now: Date = new Date()): boolean {
  return new Date(location.expiresAt).getTime() <= now.getTime();
}

/** True when a location expires within `withinMs` (default 15 minutes) but has not expired yet. */
export function isExpiringSoon(
  location: Pick<ParticipantLocation, 'expiresAt'>,
  now: Date = new Date(),
  withinMs = 15 * 60 * 1000,
): boolean {
  const remaining = new Date(location.expiresAt).getTime() - now.getTime();
  return remaining > 0 && remaining <= withinMs;
}
