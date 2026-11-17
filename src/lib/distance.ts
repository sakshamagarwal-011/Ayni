import type { Coordinates, MeetingSpot, Participant, RouteEstimate, TravelMode } from '../types';
import { hasFreshLocation } from '../coordination/expiry';

export const EARTH_RADIUS_M = 6_371_000;

/** Average speeds in km/h. Deterministic — no live traffic data. */
export const MODE_SPEEDS_KMH: Record<TravelMode, number> = {
  walk: 5,
  // Scooter/two-wheeler: realistic urban average. "Bike" in this app
  // means scooter (user choice 2026-11-17); there is no bicycle mode.
  scooter: 25,
  car: 25,
  transit: 20,
};

export const MODE_LABELS: Record<TravelMode, string> = {
  walk: 'Walk',
  scooter: 'Scooter',
  car: 'Car',
  transit: 'Transit',
};

export const TRAVEL_MODES: TravelMode[] = ['walk', 'scooter', 'car', 'transit'];

/** Haversine great-circle distance in metres. Pure and unit-testable. */
export function haversineDistanceM(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Deterministic duration: road factor 1.3x straight-line distance + mode overhead. */
export function estimateDurationMin(distanceM: number, mode: TravelMode): number {
  const roadM = distanceM * 1.3;
  const hours = roadM / 1000 / MODE_SPEEDS_KMH[mode];
  const overhead = mode === 'transit' ? 8 : mode === 'car' ? 5 : 0;
  return Math.max(1, Math.round(hours * 60 + overhead));
}

/** Build one deterministic estimate for a participant -> spot -> mode. */
export function buildRouteEstimate(
  roomId: string,
  participant: Participant,
  spot: MeetingSpot,
  mode: TravelMode,
  now: Date = new Date(),
): RouteEstimate | null {
  // Expired locations must never produce estimates: this is the choke
  // point every estimate consumer shares (services + map routes).
  if (!participant.location || !hasFreshLocation(participant, now)) return null;
  const from = { lat: participant.location.lat, lng: participant.location.lng };
  const distanceM = Math.round(haversineDistanceM(from, spot.location) * 1.3);
  return {
    id: `${participant.id}-${spot.id}-${mode}`,
    roomId,
    participantId: participant.id,
    spotId: spot.id,
    mode,
    distanceM,
    durationMin: estimateDurationMin(distanceM / 1.3, mode),
    // Straight-line geometry so estimates can still be drawn on the map.
    geometry: [
      [from.lng, from.lat],
      [spot.location.lng, spot.location.lat],
    ],
    source: 'estimated',
  };
}

export function buildAllRouteEstimates(
  roomId: string,
  participants: Participant[],
  spots: MeetingSpot[],
  now: Date = new Date(),
): RouteEstimate[] {
  const out: RouteEstimate[] = [];
  for (const p of participants) {
    for (const s of spots) {
      for (const mode of TRAVEL_MODES) {
        const est = buildRouteEstimate(roomId, p, s, mode, now);
        if (est) out.push(est);
      }
    }
  }
  return out;
}

/** Fairness score: lower total + lower max travel is better. Used for ranking spots. */
export function spotScore(estimates: RouteEstimate[], spotId: string, mode: TravelMode): number {
  const filtered = estimates.filter((e) => e.spotId === spotId && e.mode === mode);
  if (filtered.length === 0) return Number.POSITIVE_INFINITY;
  const total = filtered.reduce((sum, e) => sum + e.durationMin, 0);
  const max = Math.max(...filtered.map((e) => e.durationMin));
  return total + max * 0.5;
}
