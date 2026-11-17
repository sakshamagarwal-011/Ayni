import { haversineDistanceM } from '../lib/distance';
import { centreForPoints } from '../map/geo';
import type { ParticipantOrigin, SearchArea } from './types';

/**
 * Step 2 — candidate search areas from the participants' geographic
 * distribution. Pure and deterministic.
 *
 * STRAIGHT-LINE BOUNDARY: haversine distance is used here ONLY to size
 * search circles (geometry). It is never converted into a travel time
 * and never influences ranking. Final ranking uses OSRM road durations
 * only. See ENGINE.md.
 *
 * Design:
 * - Area 1 always exists: a circle around the Turf centre of all
 *   origins. Radius = median origin-to-centre distance + 1 km buffer,
 *   clamped to [2, 25] km so tiny groups still search a useful area
 *   and huge spreads do not ask Overpass for a whole region.
 * - Wide spreads: when the bounding-box diagonal exceeds 50 km, two
 *   extra 5 km circles are added around the two most distant origins
 *   (total 3 areas, the hard cap), so far-apart groups still find
 *   places near each end. A warning is recorded by the orchestrator.
 * - 1 origin: radius is the 2 km floor. Co-located origins: same.
 */

export const MIN_SEARCH_RADIUS_KM = 2;
export const MAX_SEARCH_RADIUS_KM = 25;
export const WIDE_SPREAD_DIAGONAL_KM = 50;
export const WIDE_SPREAD_EXTRA_RADIUS_KM = 5;
const RADIUS_BUFFER_KM = 1;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clampRadius(km: number): number {
  return Math.min(MAX_SEARCH_RADIUS_KM, Math.max(MIN_SEARCH_RADIUS_KM, km));
}

/** Bounding-box diagonal in kilometres (haversine between opposite corners — geometry only). */
export function spreadDiagonalKm(origins: ParticipantOrigin[]): number {
  if (origins.length < 2) return 0;
  const lats = origins.map((o) => o.lat);
  const lngs = origins.map((o) => o.lng);
  return (
    haversineDistanceM(
      { lat: Math.min(...lats), lng: Math.min(...lngs) },
      { lat: Math.max(...lats), lng: Math.max(...lngs) },
    ) / 1000
  );
}

export function generateSearchAreas(origins: ParticipantOrigin[]): SearchArea[] {
  if (origins.length === 0) return [];
  const centre = centreForPoints(origins.map((o) => ({ lat: o.lat, lng: o.lng }))) ?? {
    lat: origins[0].lat,
    lng: origins[0].lng,
  };
  const distancesKm = origins.map(
    (o) => haversineDistanceM({ lat: o.lat, lng: o.lng }, centre) / 1000,
  );
  const radiusKm = clampRadius(median(distancesKm) + RADIUS_BUFFER_KM);
  const areas: SearchArea[] = [
    {
      centerLat: centre.lat,
      centerLng: centre.lng,
      radiusKm,
      reason: `Circle around the group centre (median ${median(distancesKm).toFixed(1)} km from centre + 1 km buffer).`,
    },
  ];

  const diagonal = spreadDiagonalKm(origins);
  if (diagonal > WIDE_SPREAD_DIAGONAL_KM && origins.length >= 2) {
    // Two most distant origins: the pair with the largest separation.
    let best: [ParticipantOrigin, ParticipantOrigin] | null = null;
    let bestDist = -1;
    for (let i = 0; i < origins.length; i += 1) {
      for (let j = i + 1; j < origins.length; j += 1) {
        const d = haversineDistanceM(
          { lat: origins[i].lat, lng: origins[i].lng },
          { lat: origins[j].lat, lng: origins[j].lng },
        );
        if (d > bestDist) {
          bestDist = d;
          best = [origins[i], origins[j]];
        }
      }
    }
    if (best) {
      for (const origin of best) {
        areas.push({
          centerLat: origin.lat,
          centerLng: origin.lng,
          radiusKm: WIDE_SPREAD_EXTRA_RADIUS_KM,
          reason: `Wide spread (${diagonal.toFixed(0)} km across): extra search near ${origin.displayName}.`,
        });
      }
    }
  }
  return areas.slice(0, 3);
}
