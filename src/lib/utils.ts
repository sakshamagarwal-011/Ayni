import type { Coordinates } from '../types';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function formatDistance(distanceM: number): string {
  if (distanceM < 1000) return `${Math.round(distanceM)} m`;
  return `${(distanceM / 1000).toFixed(1)} km`;
}

export function formatDuration(durationMin: number): string {
  if (durationMin < 60) return `${Math.round(durationMin)} min`;
  const h = Math.floor(durationMin / 60);
  const m = Math.round(durationMin % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}

export function priceLabel(level: number): string {
  return '₹'.repeat(Math.max(1, Math.min(3, level)));
}

/**
 * OpenStreetMap directions link, constructed only as an href from
 * coordinates. Clearly labelled as external in the UI. MeetSync uses
 * MapLibre + OpenStreetMap + OSRM; no other maps provider is embedded
 * or linked.
 */
export function osmDirectionsUrl(from: Coordinates | null, to: Coordinates): string {
  const toParam = `${to.lat},${to.lng}`;
  const fromParam = from ? `from=${encodeURIComponent(`${from.lat},${from.lng}`)}&` : '';
  return `https://www.openstreetmap.org/directions?${fromParam}to=${encodeURIComponent(toParam)}`;
}

export function geoUrl(lat: number, lng: number): string {
  return `geo:${lat},${lng}?q=${encodeURIComponent(`${lat},${lng}`)}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function joinUrlForCode(code: string): string {
  return `${window.location.origin}/join/${code}`;
}
