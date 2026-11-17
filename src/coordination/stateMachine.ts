/**
 * Meeting status state machine. Pure: no service imports, no I/O.
 *
 * States are exactly the DB CHECK set (migration 0001); no new states
 * are introduced here:
 *
 *   lobby ──► discovering ──► comparing ──► finalized
 *     │            │              │
 *     └────────────┴────► comparing (direct, for flows that skip discovering)
 *     │            │              │
 *     └────────────┴──────────────┴──► expired  (system only, on expires_at)
 *
 * `finalized` and `expired` are terminal: no transitions out, and a
 * finalized room is never auto-expired (it must keep showing the same
 * destination). Status advances today are: create → lobby,
 * finalize → finalized (Edge Function), expiry → expired (system /
 * cleanup). `discovering` / `comparing` are informational states in the
 * CHECK set for future use; the guards below treat lobby, discovering
 * and comparing uniformly as "open" states, so nothing depends on a
 * page-view write to advance status.
 *
 * Finalization is the only decision transition and is guarded in three
 * places with the same rules: this module (UI + mock service),
 * finalize-meeting (Edge Function), and RLS (no direct writes).
 */
import type { MeetingRoom, RoomStatus } from '../types';
import { CoordinationError, type CoordinationErrorCode } from './errors';

export type RoomAction = 'vote' | 'finalize' | 'optimize' | 'publish' | 'join' | 'updateLocation' | 'arrive';

export interface TransitionActor {
  isHost: boolean;
  isMember: boolean;
  isSystem: boolean;
}

export interface TransitionContext {
  /** Wall-clock expiry (see expiry.ts: finalized rooms never count as expired). */
  isExpired: boolean;
  /** Whether the transition carries a finalized spot. */
  hasFinalizedSpot: boolean;
}

export interface TransitionCheck {
  allowed: boolean;
  reason?: string;
  code?: CoordinationErrorCode;
}

export const OPEN_STATUSES: RoomStatus[] = ['lobby', 'discovering', 'comparing'];

export function isOpenStatus(status: RoomStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function isTerminalStatus(status: RoomStatus): boolean {
  return status === 'finalized' || status === 'expired';
}

const FORWARD_EDGES: Partial<Record<RoomStatus, RoomStatus[]>> = {
  lobby: ['discovering', 'comparing', 'finalized', 'expired'],
  discovering: ['comparing', 'finalized', 'expired'],
  comparing: ['finalized', 'expired'],
  finalized: [],
  expired: [],
};

export function canTransition(
  from: RoomStatus,
  to: RoomStatus,
  actor: TransitionActor,
  context: TransitionContext,
): TransitionCheck {
  if (from === to) {
    return { allowed: false, reason: `The meeting is already ${from}.` };
  }
  if (isTerminalStatus(from)) {
    if (from === 'finalized') {
      return {
        allowed: false,
        reason: 'This meeting is already finalized and cannot be changed.',
        code: 'ALREADY_FINALIZED',
      };
    }
    return {
      allowed: false,
      reason: 'This meeting has expired and cannot be changed.',
      code: 'EXPIRED',
    };
  }
  if (!(FORWARD_EDGES[from] ?? []).includes(to)) {
    return { allowed: false, reason: `Cannot move a meeting from ${from} to ${to}.` };
  }
  if (to === 'expired') {
    if (!actor.isSystem) {
      return { allowed: false, reason: 'Only the system can expire a meeting.' };
    }
    return { allowed: true };
  }
  if (context.isExpired) {
    return {
      allowed: false,
      reason: 'This meeting link has expired.',
      code: 'EXPIRED',
    };
  }
  if (to === 'finalized') {
    if (!actor.isMember) {
      return {
        allowed: false,
        reason: 'You must join this room before finalizing it.',
        code: 'NOT_MEMBER',
      };
    }
    if (!actor.isHost) {
      return {
        allowed: false,
        reason: 'Only the host can finalize the meeting.',
        code: 'NOT_HOST',
      };
    }
    if (!context.hasFinalizedSpot) {
      return { allowed: false, reason: 'A destination spot is required to finalize.' };
    }
    return { allowed: true };
  }
  // Forward progress (lobby -> discovering/comparing, discovering -> comparing).
  if (!actor.isMember && !actor.isSystem) {
    return {
      allowed: false,
      reason: 'You must join this room first.',
      code: 'NOT_MEMBER',
    };
  }
  return { allowed: true };
}

/** Apply a transition, returning a new room object, or throw a typed CoordinationError. */
export function transitionRoom(
  room: MeetingRoom,
  to: RoomStatus,
  actor: TransitionActor,
  context: TransitionContext,
  now: Date = new Date(),
): MeetingRoom {
  const check = canTransition(room.status, to, actor, context);
  if (!check.allowed) {
    throw new CoordinationError(check.code ?? 'UNKNOWN', check.reason ?? 'This change is not allowed.');
  }
  return { ...room, status: to, updatedAt: now.toISOString() };
}

export interface ActionCheck {
  allowed: boolean;
  reason?: string;
  code?: CoordinationErrorCode;
}

export interface ActionContext {
  isHost?: boolean;
  isMember?: boolean;
  /** Wall-clock expiry (finalized rooms never count as expired — see expiry.ts). */
  isExpired?: boolean;
}

/**
 * Whether an action is allowed in a status. This is the single rule set
 * used by the UI (disable + explain), the mock service, and the
 * Supabase service guards. The Edge Functions enforce the same rules
 * server-side; RLS is the final backstop.
 *
 * - vote / optimize / publish: open states, members only, not expired.
 *   Voting is closed once finalized (the outcome must not change);
 *   publishing follows the same rules as optimize because it extends
 *   a search result into the room's votable spots.
 * - finalize: open states, host only, not expired.
 * - join: open states and finalized (view-only: a late joiner can see
 *   the announcement and navigate, but cannot vote or change the
 *   outcome). Expired rooms cannot be joined.
 * - updateLocation: members, any non-expired status including
 *   finalized (navigation needs fresh locations).
 * - arrive: finalized only, members only.
 */
export function isActionAllowed(status: RoomStatus, action: RoomAction, context: ActionContext = {}): ActionCheck {
  const isExpired = context.isExpired ?? false;
  const isMember = context.isMember ?? false;
  const isHost = context.isHost ?? false;

  if (action !== 'join' && isExpired) {
    return { allowed: false, reason: 'This meeting has expired.', code: 'EXPIRED' };
  }
  // An explicitly 'expired' status blocks every action except join
  // (whose own branch reports the same code), even when the caller
  // did not pass the wall-clock isExpired flag.
  if (status === 'expired' && action !== 'join') {
    return { allowed: false, reason: 'This meeting has expired.', code: 'EXPIRED' };
  }

  switch (action) {
    case 'join':
      if (isExpired || status === 'expired') {
        return { allowed: false, reason: 'This meeting link has expired.', code: 'EXPIRED' };
      }
      return { allowed: true };
    case 'vote':
      if (status === 'finalized') {
        return {
          allowed: false,
          reason: 'Voting is closed — this meeting is already finalized.',
          code: 'ALREADY_FINALIZED',
        };
      }
      if (!isMember) {
        return { allowed: false, reason: 'Join this room first to vote.', code: 'NOT_MEMBER' };
      }
      return { allowed: true };
    case 'optimize':
      if (status === 'finalized') {
        return {
          allowed: false,
          reason: 'This meeting is already finalized, so a new search cannot run.',
          code: 'ALREADY_FINALIZED',
        };
      }
      if (!isMember) {
        return { allowed: false, reason: 'Join this room first to run a search.', code: 'NOT_MEMBER' };
      }
      return { allowed: true };
    case 'publish':
      if (status === 'finalized') {
        return {
          allowed: false,
          reason: 'This meeting is already finalized, so new spots cannot be published.',
          code: 'ALREADY_FINALIZED',
        };
      }
      if (!isMember) {
        return { allowed: false, reason: 'Join this room first to publish search results.', code: 'NOT_MEMBER' };
      }
      return { allowed: true };
    case 'finalize':
      if (status === 'finalized') {
        return {
          allowed: false,
          reason: 'This meeting is already finalized.',
          code: 'ALREADY_FINALIZED',
        };
      }
      if (!isMember) {
        return { allowed: false, reason: 'You must join this room before finalizing it.', code: 'NOT_MEMBER' };
      }
      if (!isHost) {
        return { allowed: false, reason: 'Only the host can finalize the meeting.', code: 'NOT_HOST' };
      }
      return { allowed: true };
    case 'updateLocation':
      if (!isMember) {
        return {
          allowed: false,
          reason: 'Join this room first to update your location.',
          code: 'NOT_MEMBER',
        };
      }
      return { allowed: true };
    case 'arrive':
      if (status !== 'finalized') {
        return {
          allowed: false,
          reason: 'Arrival can only be confirmed once the meeting is finalized.',
          code: 'NOT_FINALIZED',
        };
      }
      if (!isMember) {
        return { allowed: false, reason: 'Join this room first to confirm arrival.', code: 'NOT_MEMBER' };
      }
      return { allowed: true };
    default:
      return { allowed: false, reason: 'Unknown action.' };
  }
}
