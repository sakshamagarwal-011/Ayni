import { describe, expect, it } from 'vitest';
import {
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  isValidInviteCode,
  normalizeInviteCode,
  validateDisplayName,
  validateInviteCode,
  validateLat,
  validateLng,
  validateTitle,
} from '../../src/lib/validation';

describe('invite codes', () => {
  it('uses a 6-character unambiguous alphabet', () => {
    expect(INVITE_CODE_LENGTH).toBe(6);
    expect(INVITE_ALPHABET).not.toMatch(/[01OIol]/);
    expect(INVITE_ALPHABET.length).toBe(31);
  });

  it('normalizes codes (trim, uppercase, strip dashes/spaces)', () => {
    expect(normalizeInviteCode('  k7m2-qx ')).toBe('K7M2QX');
    expect(normalizeInviteCode('k7 m2 qx')).toBe('K7M2QX');
  });

  it('accepts valid codes and rejects ambiguous/invalid ones', () => {
    expect(isValidInviteCode('K7M2QX')).toBe(true);
    expect(isValidInviteCode('k7m2qx')).toBe(true);
    expect(isValidInviteCode('K7M2Q0')).toBe(false); // 0 is ambiguous
    expect(isValidInviteCode('K7M2QO')).toBe(false); // O is ambiguous
    expect(isValidInviteCode('K7M2Q1')).toBe(false); // 1 is ambiguous
    expect(isValidInviteCode('K7M2Q')).toBe(false); // too short
    expect(isValidInviteCode('K7M2QXY')).toBe(false); // too long
    expect(isValidInviteCode('')).toBe(false);
  });

  it('validateInviteCode returns helpful errors', () => {
    expect(validateInviteCode('')).toMatch(/required/);
    expect(validateInviteCode('BAD!')).toMatch(/valid 6-character/);
    expect(validateInviteCode('K7M2QX')).toBeNull();
  });
});

describe('validation', () => {
  it('validates meeting titles (3-60 chars)', () => {
    expect(validateTitle('ab')).not.toBeNull();
    expect(validateTitle('abc')).toBeNull();
    expect(validateTitle('a'.repeat(60))).toBeNull();
    expect(validateTitle('a'.repeat(61))).not.toBeNull();
    expect(validateTitle('   ')).not.toBeNull();
  });

  it('validates display names (2-30 chars)', () => {
    expect(validateDisplayName('A')).not.toBeNull();
    expect(validateDisplayName('Al')).toBeNull();
    expect(validateDisplayName('a'.repeat(30))).toBeNull();
    expect(validateDisplayName('a'.repeat(31))).not.toBeNull();
  });

  it('validates lat/lng ranges', () => {
    expect(validateLat(12.97)).toBeNull();
    expect(validateLat(-90)).toBeNull();
    expect(validateLat(90)).toBeNull();
    expect(validateLat(91)).not.toBeNull();
    expect(validateLat(Number.NaN)).not.toBeNull();
    expect(validateLng(77.64)).toBeNull();
    expect(validateLng(180)).toBeNull();
    expect(validateLng(181)).not.toBeNull();
  });
});
