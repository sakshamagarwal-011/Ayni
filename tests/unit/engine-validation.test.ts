import { describe, expect, it } from 'vitest';
import { OptimizationValidationError } from '../../src/engine/errors';
import {
  assertValidOptimizationInput,
  optimizationWarnings,
  validateOptimizationInput,
} from '../../src/engine/validation';
import type { OptimizationInput, ParticipantOrigin } from '../../src/engine/types';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const FUTURE = '2026-11-17T14:00:00.000Z';
const EXPIRES = '2026-11-17T14:00:00.000Z';
const UPDATED = '2026-11-17T11:30:00.000Z';

function origin(overrides: Partial<ParticipantOrigin> = {}): ParticipantOrigin {
  return {
    participantId: 'p1',
    displayName: 'Aarav',
    lat: 12.9716,
    lng: 77.6412,
    mode: 'car',
    required: true,
    locationUpdatedAt: UPDATED,
    locationExpiresAt: EXPIRES,
    consentGiven: true,
    ...overrides,
  };
}

function input(overrides: Partial<OptimizationInput> = {}): OptimizationInput {
  return {
    roomId: 'room-1',
    roomStatus: 'lobby',
    currentParticipantId: 'p1',
    memberParticipantIds: ['p1', 'p2'],
    requiredParticipantIds: ['p1', 'p2'],
    origins: [
      origin(),
      origin({ participantId: 'p2', displayName: 'Priya', lat: 12.9352, lng: 77.6245, mode: 'walk' }),
    ],
    category: 'cafe',
    meetingTimeISO: FUTURE,
    preference: 'balanced',
    ...overrides,
  };
}

describe('validateOptimizationInput', () => {
  it('accepts a valid input', () => {
    expect(validateOptimizationInput(input(), NOW)).toEqual([]);
  });

  it('rejects a non-member runner', () => {
    const issues = validateOptimizationInput(input({ currentParticipantId: 'outsider' }), NOW);
    expect(issues.join(' ')).toMatch(/join this room/);
  });

  it('rejects origins from non-members', () => {
    const issues = validateOptimizationInput(
      input({ origins: [origin(), origin({ participantId: 'ghost', displayName: 'Ghost' })] }),
      NOW,
    );
    expect(issues.join(' ')).toMatch(/not a member/);
  });

  it('rejects missing consent for required origins (and names them)', () => {
    const issues = validateOptimizationInput(
      input({ origins: [origin({ consentGiven: false }), origin({ participantId: 'p2', displayName: 'Priya' })] }),
      NOW,
    );
    expect(issues.join(' ')).toMatch(/Aarav/);
    expect(issues.join(' ')).toMatch(/consent/);
  });

  it('allows missing consent for optional origins', () => {
    const issues = validateOptimizationInput(
      input({
        origins: [origin(), origin({ participantId: 'p2', displayName: 'Priya', required: false, consentGiven: false })],
      }),
      NOW,
    );
    expect(issues).toEqual([]);
  });

  it('rejects invalid coordinates', () => {
    const issues = validateOptimizationInput(input({ origins: [origin({ lat: 91 }), origin({ participantId: 'p2' })] }), NOW);
    expect(issues.join(' ')).toMatch(/invalid location/);
  });

  it('rejects expired locations and names the participants', () => {
    const issues = validateOptimizationInput(
      input({
        origins: [
          origin({ locationExpiresAt: '2026-11-17T11:00:00.000Z' }),
          origin({ participantId: 'p2', displayName: 'Priya' }),
        ],
      }),
      NOW,
    );
    expect(issues.join(' ')).toMatch(/expired/);
    expect(issues.join(' ')).toMatch(/Aarav/);
  });

  it('rejects a required participant with no origin', () => {
    const issues = validateOptimizationInput(input({ origins: [origin()] }), NOW);
    expect(issues.join(' ')).toMatch(/no location/);
  });

  it('rejects finalized and expired meetings', () => {
    expect(validateOptimizationInput(input({ roomStatus: 'finalized' }), NOW).join(' ')).toMatch(/finalized/);
    expect(validateOptimizationInput(input({ roomStatus: 'expired' }), NOW).join(' ')).toMatch(/expired/);
    expect(validateOptimizationInput(input({ roomStatus: 'discovering' }), NOW)).toEqual([]);
    expect(validateOptimizationInput(input({ roomStatus: 'comparing' }), NOW)).toEqual([]);
  });

  it('rejects an invalid meeting time and one more than 24h in the past', () => {
    expect(validateOptimizationInput(input({ meetingTimeISO: 'not-a-date' }), NOW).join(' ')).toMatch(/valid date/);
    expect(validateOptimizationInput(input({ meetingTimeISO: '2026-11-15T11:00:00.000Z' }), NOW).join(' ')).toMatch(
      /24 hours/,
    );
    // 1 hour in the past is allowed (meetings run late).
    expect(validateOptimizationInput(input({ meetingTimeISO: '2026-11-17T11:00:00.000Z' }), NOW)).toEqual([]);
  });

  it('rejects bad enums and out-of-range constraints', () => {
    expect(validateOptimizationInput(input({ category: 'casino' as never }), NOW).length).toBeGreaterThan(0);
    expect(validateOptimizationInput(input({ preference: 'cheapest' as never }), NOW).length).toBeGreaterThan(0);
    expect(validateOptimizationInput(input({ maxTravelMinutes: 3 }), NOW).join(' ')).toMatch(/5 and 240/);
    expect(validateOptimizationInput(input({ maxTravelMinutes: 300 }), NOW).join(' ')).toMatch(/5 and 240/);
    expect(validateOptimizationInput(input({ maxCandidates: 0 }), NOW).length).toBeGreaterThan(0);
    expect(validateOptimizationInput(input({ maxCandidates: 21 }), NOW).length).toBeGreaterThan(0);
    expect(validateOptimizationInput(input({ maxTravelMinutes: 45, maxCandidates: 12 }), NOW)).toEqual([]);
  });

  it('rejects duplicate origins and zero required origins', () => {
    expect(validateOptimizationInput(input({ origins: [origin(), origin()] }), NOW).join(' ')).toMatch(/more than once/);
    const optional = [origin({ required: false }), origin({ participantId: 'p2', required: false })];
    expect(validateOptimizationInput(input({ origins: optional }), NOW).join(' ')).toMatch(/At least one/);
  });

  it('assertValidOptimizationInput throws a typed error listing all issues', () => {
    expect(() => assertValidOptimizationInput(input({ roomStatus: 'finalized' }), NOW)).toThrowError(
      OptimizationValidationError,
    );
    try {
      assertValidOptimizationInput(input({ roomStatus: 'finalized', maxTravelMinutes: 1 }), NOW);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OptimizationValidationError);
      expect((err as OptimizationValidationError).issues.length).toBeGreaterThanOrEqual(2);
      expect((err as OptimizationValidationError).code).toBe('validation');
    }
  });
});

describe('optimizationWarnings', () => {
  it('warns on a solo search', () => {
    const solo = input({
      memberParticipantIds: ['p1'],
      requiredParticipantIds: ['p1'],
      origins: [origin()],
    });
    expect(validateOptimizationInput(solo, NOW)).toEqual([]);
    expect(optimizationWarnings(solo, NOW).join(' ')).toMatch(/Only one participant/);
  });

  it('warns on a far-future meeting time', () => {
    const far = input({ meetingTimeISO: '2027-01-01T12:00:00.000Z' });
    expect(optimizationWarnings(far, NOW).join(' ')).toMatch(/30 days/);
  });
});
