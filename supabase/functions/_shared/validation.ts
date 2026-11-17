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

export const AVATAR_COLORS = ['#3B82F6', '#8B5CF6', '#10B981', '#F59E0B', '#EC4899', '#06B6D4'];

export function avatarColorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
