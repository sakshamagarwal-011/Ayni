import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isActionAllowed,
  isOpenStatus,
  isTerminalStatus,
  transitionRoom,
  type TransitionActor,
  type TransitionContext,
} from '../../src/coordination/stateMachine';
import { CoordinationError } from '../../src/coordination/errors';
import type { MeetingRoom } from '../../src/types';

const HOST: TransitionActor = { isHost: true, isMember: true, isSystem: false };
const MEMBER: TransitionActor = { isHost: false, isMember: true, isSystem: false };
const OUTSIDER: TransitionActor = { isHost: false, isMember: false, isSystem: false };
const SYSTEM: TransitionActor = { isHost: false, isMember: false, isSystem: true };
const FRESH: TransitionContext = { isExpired: false, hasFinalizedSpot: true };
const NO_SPOT: TransitionContext = { isExpired: false, hasFinalizedSpot: false };
const EXPIRED: TransitionContext = { isExpired: true, hasFinalizedSpot: true };

function room(status: MeetingRoom['status']): MeetingRoom {
  return {
    id: 'room-1',
    inviteCode: 'ABCDEF',
    title: 'Test',
    hostAuthUid: 'auth-1',
    status,
    finalizedSpotId: null,
    decisionVersion: 1,
    finalizedAt: null,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    expiresAt: '2026-11-18T00:00:00.000Z',
  };
}

describe('isTerminalStatus / isOpenStatus', () => {
  it('finalized and expired are terminal; open states are not', () => {
    expect(isTerminalStatus('finalized')).toBe(true);
    expect(isTerminalStatus('expired')).toBe(true);
    expect(isTerminalStatus('lobby')).toBe(false);
    expect(isTerminalStatus('discovering')).toBe(false);
    expect(isTerminalStatus('comparing')).toBe(false);
    expect(isOpenStatus('lobby')).toBe(true);
    expect(isOpenStatus('discovering')).toBe(true);
    expect(isOpenStatus('comparing')).toBe(true);
    expect(isOpenStatus('finalized')).toBe(false);
    expect(isOpenStatus('expired')).toBe(false);
  });
});

describe('canTransition: forward progress', () => {
  it('allows lobby -> discovering for a member', () => {
    expect(canTransition('lobby', 'discovering', MEMBER, FRESH).allowed).toBe(true);
  });
  it('allows discovering -> comparing for a member', () => {
    expect(canTransition('discovering', 'comparing', MEMBER, FRESH).allowed).toBe(true);
  });
  it('allows lobby -> comparing directly (flows that skip discovering)', () => {
    expect(canTransition('lobby', 'comparing', MEMBER, FRESH).allowed).toBe(true);
  });
  it('rejects backwards transitions', () => {
    expect(canTransition('comparing', 'lobby', HOST, FRESH).allowed).toBe(false);
    expect(canTransition('discovering', 'lobby', HOST, FRESH).allowed).toBe(false);
    expect(canTransition('comparing', 'discovering', HOST, FRESH).allowed).toBe(false);
  });
  it('rejects same-state transitions', () => {
    expect(canTransition('lobby', 'lobby', HOST, FRESH).allowed).toBe(false);
  });
  it('rejects forward progress for non-members', () => {
    const check = canTransition('lobby', 'discovering', OUTSIDER, FRESH);
    expect(check.allowed).toBe(false);
    expect(check.code).toBe('NOT_MEMBER');
  });
});

describe('canTransition: finalization', () => {
  it('allows comparing -> finalized for the host with a spot', () => {
    expect(canTransition('comparing', 'finalized', HOST, FRESH).allowed).toBe(true);
  });
  it('allows lobby/discovering -> finalized for the host with a spot', () => {
    expect(canTransition('lobby', 'finalized', HOST, FRESH).allowed).toBe(true);
    expect(canTransition('discovering', 'finalized', HOST, FRESH).allowed).toBe(true);
  });
  it('rejects finalization by a non-host member', () => {
    const check = canTransition('comparing', 'finalized', MEMBER, FRESH);
    expect(check.allowed).toBe(false);
    expect(check.code).toBe('NOT_HOST');
  });
  it('rejects finalization by a non-member', () => {
    const check = canTransition('comparing', 'finalized', OUTSIDER, FRESH);
    expect(check.allowed).toBe(false);
    expect(check.code).toBe('NOT_MEMBER');
  });
  it('rejects finalization without a spot', () => {
    expect(canTransition('comparing', 'finalized', HOST, NO_SPOT).allowed).toBe(false);
  });
  it('rejects finalization when expired', () => {
    const check = canTransition('comparing', 'finalized', HOST, EXPIRED);
    expect(check.allowed).toBe(false);
    expect(check.code).toBe('EXPIRED');
  });
});

describe('canTransition: expiry and terminal states', () => {
  it('allows any non-finalized state -> expired for the system', () => {
    expect(canTransition('lobby', 'expired', SYSTEM, FRESH).allowed).toBe(true);
    expect(canTransition('discovering', 'expired', SYSTEM, FRESH).allowed).toBe(true);
    expect(canTransition('comparing', 'expired', SYSTEM, FRESH).allowed).toBe(true);
  });
  it('rejects expiry by non-system actors', () => {
    expect(canTransition('lobby', 'expired', HOST, FRESH).allowed).toBe(false);
    expect(canTransition('lobby', 'expired', MEMBER, FRESH).allowed).toBe(false);
  });
  it('rejects every transition out of finalized', () => {
    for (const to of ['lobby', 'discovering', 'comparing', 'expired'] as const) {
      const check = canTransition('finalized', to, SYSTEM, FRESH);
      expect(check.allowed).toBe(false);
      expect(check.code).toBe('ALREADY_FINALIZED');
    }
  });
  it('rejects every transition out of expired', () => {
    for (const to of ['lobby', 'discovering', 'comparing', 'finalized'] as const) {
      expect(canTransition('expired', to, SYSTEM, FRESH).allowed).toBe(false);
    }
  });
  it('rejects forward progress when expired', () => {
    const check = canTransition('lobby', 'discovering', MEMBER, EXPIRED);
    expect(check.allowed).toBe(false);
    expect(check.code).toBe('EXPIRED');
  });
});

describe('transitionRoom', () => {
  it('returns a new room with the new status and updated timestamp', () => {
    const before = room('lobby');
    const after = transitionRoom(before, 'discovering', MEMBER, FRESH, new Date('2026-11-17T10:00:00.000Z'));
    expect(after.status).toBe('discovering');
    expect(after.updatedAt).toBe('2026-11-17T10:00:00.000Z');
    expect(before.status).toBe('lobby');
  });
  it('throws a typed CoordinationError for forbidden transitions', () => {
    expect(() => transitionRoom(room('finalized'), 'comparing', HOST, FRESH)).toThrow(CoordinationError);
    try {
      transitionRoom(room('finalized'), 'comparing', HOST, FRESH);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CoordinationError);
      expect((e as CoordinationError).code).toBe('ALREADY_FINALIZED');
    }
  });
});

describe('isActionAllowed', () => {
  it('vote: members in open states only; closed when finalized; blocked when expired', () => {
    expect(isActionAllowed('lobby', 'vote', { isMember: true }).allowed).toBe(true);
    expect(isActionAllowed('comparing', 'vote', { isMember: true }).allowed).toBe(true);
    expect(isActionAllowed('lobby', 'vote', {}).code).toBe('NOT_MEMBER');
    expect(isActionAllowed('finalized', 'vote', { isMember: true }).code).toBe('ALREADY_FINALIZED');
    expect(isActionAllowed('lobby', 'vote', { isMember: true, isExpired: true }).code).toBe('EXPIRED');
  });
  it('finalize: host members in open states only', () => {
    expect(isActionAllowed('comparing', 'finalize', { isMember: true, isHost: true }).allowed).toBe(true);
    expect(isActionAllowed('comparing', 'finalize', { isMember: true }).code).toBe('NOT_HOST');
    expect(isActionAllowed('comparing', 'finalize', {}).code).toBe('NOT_MEMBER');
    expect(isActionAllowed('finalized', 'finalize', { isMember: true, isHost: true }).code).toBe('ALREADY_FINALIZED');
    expect(isActionAllowed('expired', 'finalize', { isMember: true, isHost: true }).code).toBe('EXPIRED');
  });
  it('optimize: members in open states; blocked when finalized or expired', () => {
    expect(isActionAllowed('lobby', 'optimize', { isMember: true }).allowed).toBe(true);
    expect(isActionAllowed('finalized', 'optimize', { isMember: true }).code).toBe('ALREADY_FINALIZED');
    expect(isActionAllowed('lobby', 'optimize', { isMember: true, isExpired: true }).code).toBe('EXPIRED');
  });
  it('publish: same rules as optimize — members in open states; blocked when finalized or expired', () => {
    expect(isActionAllowed('lobby', 'publish', { isMember: true }).allowed).toBe(true);
    expect(isActionAllowed('discovering', 'publish', { isMember: true }).allowed).toBe(true);
    expect(isActionAllowed('comparing', 'publish', { isMember: true }).allowed).toBe(true);
    // Host is NOT required: any member may publish their search.
    expect(isActionAllowed('lobby', 'publish', { isMember: true, isHost: false }).allowed).toBe(true);
    // Omitted isMember defaults to false (the f003c8b lesson): the
    // call site must pass membership explicitly.
    expect(isActionAllowed('lobby', 'publish', {}).code).toBe('NOT_MEMBER');
    expect(isActionAllowed('lobby', 'publish', { isMember: false }).code).toBe('NOT_MEMBER');
    expect(isActionAllowed('finalized', 'publish', { isMember: true }).code).toBe('ALREADY_FINALIZED');
    expect(isActionAllowed('lobby', 'publish', { isMember: true, isExpired: true }).code).toBe('EXPIRED');
    expect(isActionAllowed('expired', 'publish', { isMember: true }).code).toBe('EXPIRED');
  });
  it('join: allowed in open and finalized states (view-only), blocked when expired', () => {
    expect(isActionAllowed('lobby', 'join', {}).allowed).toBe(true);
    expect(isActionAllowed('finalized', 'join', {}).allowed).toBe(true);
    expect(isActionAllowed('expired', 'join', {}).code).toBe('EXPIRED');
    expect(isActionAllowed('lobby', 'join', { isExpired: true }).code).toBe('EXPIRED');
  });
  it('updateLocation: members in any non-expired state including finalized', () => {
    expect(isActionAllowed('lobby', 'updateLocation', { isMember: true }).allowed).toBe(true);
    expect(isActionAllowed('finalized', 'updateLocation', { isMember: true }).allowed).toBe(true);
    expect(isActionAllowed('lobby', 'updateLocation', {}).code).toBe('NOT_MEMBER');
    expect(isActionAllowed('finalized', 'updateLocation', { isMember: true, isExpired: true }).code).toBe('EXPIRED');
  });
  it('arrive: finalized only, members only', () => {
    expect(isActionAllowed('finalized', 'arrive', { isMember: true }).allowed).toBe(true);
    expect(isActionAllowed('lobby', 'arrive', { isMember: true }).allowed).toBe(false);
    expect(isActionAllowed('lobby', 'arrive', { isMember: true }).code).toBe('NOT_FINALIZED');
    expect(isActionAllowed('finalized', 'arrive', {}).code).toBe('NOT_MEMBER');
  });
});
