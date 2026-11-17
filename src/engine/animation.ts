/**
 * Pure route-animation helpers. INDEPENDENT of routing: these functions
 * accept already-computed geometries and never call any routing or
 * places endpoint. The animation layer consumes RouteGeometry only.
 *
 * Straight-line note: segment lengths here position the progressive
 * reveal along the drawn line (interpolation fractions). They are not
 * travel times and never feed ranking.
 */

/** [lng, lat] pairs, GeoJSON order. */
export type LngLat = number[];

function segmentLengthM(a: LngLat, b: LngLat): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Total length of a polyline in metres (0 for fewer than 2 points). */
export function polylineLengthM(coordinates: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    total += segmentLengthM(coordinates[i - 1], coordinates[i]);
  }
  return total;
}

/**
 * The portion of a line revealed at `progress` (0..1), interpolated
 * ALONG the line by segment length so the reveal moves at constant
 * speed regardless of vertex density. Progress is clamped to [0, 1].
 * - 0 returns just the start point (as a 2-point degenerate line so
 *   MapLibre still renders a dot-length line); callers that want an
 *   empty reveal should hide the feature instead.
 * - 1 returns a copy of the full line.
 */
export function progressGeometry(coordinates: LngLat[], progress: number): LngLat[] {
  if (coordinates.length === 0) return [];
  if (coordinates.length === 1) return [coordinates[0].slice()];
  const p = Math.min(1, Math.max(0, progress));
  if (p <= 0) return [coordinates[0].slice(), coordinates[0].slice()];
  if (p >= 1) return coordinates.map((c) => c.slice());
  const total = polylineLengthM(coordinates);
  if (total <= 0) return [coordinates[0].slice(), coordinates[coordinates.length - 1].slice()];
  const target = total * p;
  const out: LngLat[] = [coordinates[0].slice()];
  let travelled = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const segLen = segmentLengthM(coordinates[i - 1], coordinates[i]);
    if (travelled + segLen >= target) {
      const remaining = target - travelled;
      const frac = segLen > 0 ? remaining / segLen : 0;
      const [lng0, lat0] = coordinates[i - 1];
      const [lng1, lat1] = coordinates[i];
      out.push([lng0 + (lng1 - lng0) * frac, lat0 + (lat1 - lat0) * frac]);
      return out;
    }
    travelled += segLen;
    out.push(coordinates[i].slice());
  }
  return out;
}

/**
 * Evenly decimate a polyline to at most `maxPoints` points, always
 * preserving the first and last points. Used before drawing so long
 * OSRM geometries stay cheap on mid-range Android devices.
 */
export function simplifyGeometry(coordinates: LngLat[], maxPoints: number): LngLat[] {
  if (maxPoints < 2) return coordinates.length > 0 ? [coordinates[0].slice()] : [];
  if (coordinates.length <= maxPoints) return coordinates.map((c) => c.slice());
  const step = (coordinates.length - 1) / (maxPoints - 1);
  const out: LngLat[] = [];
  const picked = new Set<number>();
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.min(coordinates.length - 1, Math.round(i * step));
    if (picked.has(index)) continue;
    picked.add(index);
    out.push(coordinates[index].slice());
  }
  // Guarantee the endpoint is present even if rounding skipped it.
  const last = coordinates[coordinates.length - 1];
  const lastOut = out[out.length - 1];
  if (lastOut[0] !== last[0] || lastOut[1] !== last[1]) out.push(last.slice());
  return out;
}

/**
 * Playback duration for a route of `lengthM` metres at `speed`
 * multiplier. 1.5s per kilometre at 1x, clamped to [1.2s, 10s], so
 * short hops still read as motion and cross-city routes do not drag.
 * This is a presentation duration only — never a travel time.
 */
export function animationDurationMs(lengthM: number, speed = 1): number {
  const safeSpeed = speed > 0 ? speed : 1;
  const raw = ((lengthM / 1000) * 1500) / safeSpeed;
  return Math.min(10_000, Math.max(1200, Math.round(raw)));
}

/** Midpoint of a polyline by vertex index (for travel-time label placement). */
export function midpointOf(coordinates: LngLat[]): LngLat | null {
  if (coordinates.length === 0) return null;
  return coordinates[Math.floor(coordinates.length / 2)].slice();
}
