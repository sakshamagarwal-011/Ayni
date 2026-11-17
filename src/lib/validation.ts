/**
 * Shared validation rules (frontend + mirrored in Edge Functions).
 * Keep these in sync with supabase/functions/_shared/validation.ts.
 */

/** Unambiguous alphabet: no 0/O, 1/I/l. */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;

export const INVITE_CODE_REGEX = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export function normalizeInviteCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

export function isValidInviteCode(raw: string): boolean {
  return INVITE_CODE_REGEX.test(normalizeInviteCode(raw));
}

export function validateTitle(title: string): string | null {
  const t = title.trim();
  if (t.length < 3) return 'Meeting title must be at least 3 characters.';
  if (t.length > 60) return 'Meeting title must be 60 characters or fewer.';
  return null;
}

export function validateDisplayName(name: string): string | null {
  const n = name.trim();
  if (n.length < 2) return 'Display name must be at least 2 characters.';
  if (n.length > 30) return 'Display name must be 30 characters or fewer.';
  return null;
}

export function validateInviteCode(raw: string): string | null {
  if (!raw.trim()) return 'Invite code is required.';
  if (!isValidInviteCode(raw)) {
    return 'Enter a valid 6-character invite code (letters and digits, no 0/O/1/I).';
  }
  return null;
}

export function validateLat(lat: number): string | null {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return 'Latitude must be between -90 and 90.';
  return null;
}

export function validateLng(lng: number): string | null {
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return 'Longitude must be between -180 and 180.';
  return null;
}

/**
 * Parse free-typed coordinate text. Empty/whitespace/non-numeric text
 * returns null — NEVER 0 (Number('') === 0 previously smuggled a
 * (0, 0) "Null Island" location past validation when a field was
 * cleared).
 */
export function parseCoordinateText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function validateLocation(lat: number, lng: number, label: string): string | null {
  return validateLat(lat) ?? validateLng(lng) ?? (label.trim() ? null : 'Location label is required.');
}
