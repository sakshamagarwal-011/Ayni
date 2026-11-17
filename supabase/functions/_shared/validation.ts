// Shared validation for MeetSync 3D Edge Functions.
// Mirrors src/lib/validation.ts — keep the two in sync.

export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;

export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '');
}

export function isValidInviteCode(raw: string): boolean {
  return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(normalizeInviteCode(raw));
}

/** Secure invite code using crypto.getRandomValues (Web Crypto). */
export function generateInviteCode(): string {
  const bytes = new Uint8Array(INVITE_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
}

export function validateTitle(title: unknown): string | null {
  if (typeof title !== 'string') return 'Title is required.';
  const t = title.trim();
  if (t.length < 3) return 'Meeting title must be at least 3 characters.';
  if (t.length > 60) return 'Meeting title must be 60 characters or fewer.';
  return null;
}

export function validateDisplayName(name: unknown): string | null {
  if (typeof name !== 'string') return 'Display name is required.';
  const n = name.trim();
  if (n.length < 2) return 'Display name must be at least 2 characters.';
  if (n.length > 30) return 'Display name must be 30 characters or fewer.';
  return null;
}

export function validateLatLng(lat: unknown, lng: unknown): string | null {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return 'Latitude must be between -90 and 90.';
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return 'Longitude must be between -180 and 180.';
  }
  return null;
}

/**
 * GPS fix accuracy in metres. Absent/null means "unknown" and keeps the
 * historical default of 20 m. A provided value must be a finite number
 * in 0..100000 and is rounded to an integer.
 */
export function validateAccuracyM(value: unknown): { error: string | null; accuracyM: number } {
  if (value === undefined || value === null) return { error: null, accuracyM: 20 };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) {
    return { error: 'Accuracy must be a number between 0 and 100000 metres.', accuracyM: 20 };
  }
  return { error: null, accuracyM: Math.round(value) };
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * OSM identity as carried by CandidatePlace.osmId: 'node/123',
 * 'way/456', 'relation/789'. Mock/demo ids ('mock/<uuid>') are NOT
 * valid here — only real OSM places may be published as spots.
 */
export function isOsmId(value: unknown): value is string {
  return typeof value === 'string' && /^(node|way|relation)\/[0-9]+$/.test(value);
}

/** One place accepted by the publish-results Edge Function, normalized. */
export interface PublishPlaceInput {
  osmId: string;
  name: string;
  /** Display label (e.g. 'Café', 'Tea stall') — the candidate_spots.category column is free text, and the seeds use labels too. NOT a MeetingCategory enum key. */
  category: string;
  lat: number;
  lng: number;
  /** Empty string when the place has no address. */
  address: string;
}

/**
 * Strict validation for a publish-results places array: 1–5 places,
 * each with a real OSM id, a short name/category label, in-range
 * coordinates and an optional short address. Rating/price/open-now
 * are NEVER accepted: live places have none, and the server stores
 * placeholders the frontend must not render. Duplicate OSM ids in
 * one request are rejected so the submitted order stays unambiguous.
 */
export function validatePublishPlaces(places: unknown): {
  error: string | null;
  places: PublishPlaceInput[];
} {
  if (!Array.isArray(places)) return { error: 'places must be an array.', places: [] };
  if (places.length < 1) return { error: 'At least one place is required.', places: [] };
  if (places.length > 5) return { error: 'At most 5 places can be published at once.', places: [] };
  const seen = new Set<string>();
  const normalized: PublishPlaceInput[] = [];
  for (const raw of places) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { error: 'Each place must be an object.', places: [] };
    }
    const place = raw as Record<string, unknown>;
    if (!isOsmId(place['osmId'])) {
      return { error: 'Each place needs a valid OSM id (node/way/relation + number).', places: [] };
    }
    const osmId = place['osmId'] as string;
    if (seen.has(osmId)) return { error: 'The same place was submitted twice.', places: [] };
    seen.add(osmId);
    if (typeof place['name'] !== 'string' || place['name'].trim().length < 1) {
      return { error: 'Each place needs a name.', places: [] };
    }
    const name = (place['name'] as string).trim();
    if (name.length > 200) return { error: 'Place names must be 200 characters or fewer.', places: [] };
    if (typeof place['category'] !== 'string' || place['category'].trim().length < 1) {
      return { error: 'Each place needs a category.', places: [] };
    }
    const category = (place['category'] as string).trim();
    if (category.length > 60) return { error: 'Place categories must be 60 characters or fewer.', places: [] };
    const locError = validateLatLng(place['lat'], place['lng']);
    if (locError) return { error: locError, places: [] };
    const addressRaw = place['address'];
    if (addressRaw !== undefined && addressRaw !== null && typeof addressRaw !== 'string') {
      return { error: 'Place address must be a string.', places: [] };
    }
    const address = typeof addressRaw === 'string' ? addressRaw.trim() : '';
    if (address.length > 500) return { error: 'Place addresses must be 500 characters or fewer.', places: [] };
    normalized.push({ osmId, name, category, lat: place['lat'] as number, lng: place['lng'] as number, address });
  }
  return { error: null, places: normalized };
}

export const AVATAR_COLORS = ['#3B82F6', '#8B5CF6', '#10B981', '#F59E0B', '#EC4899', '#06B6D4'];

export function avatarColorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
