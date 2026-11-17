/**
 * Stale-optimization guard. Pure.
 *
 * An OptimizationResult is stamped (by the orchestrator) with the
 * room's decision version and a participants signature at search time.
 * A result is stale when any of these hold:
 * - the room has since been finalized or expired (decisions are closed);
 * - the room's decision version changed (a newer decision exists);
 * - the participants signature changed (someone joined/left or updated
 *   their location);
 * - any current participant's location has expired (the origins the
 *   result was computed from are no longer valid).
 *
 * A stale result must never overwrite a newer decision: finalization
 * always uses the current group winner / host-selected spot plus the
 * current decision version, never a spot id taken from a stale result.
 * The UI shows a "stale — re-run" banner and keeps the old results
 * visible but labelled, rather than silently replacing them.
 */
import { signatureFromParticipants } from '../engine/signature';
import type { OptimizationResult } from '../engine/types';
import type { MeetingRoom, Participant } from '../types';
import { isRoomExpired } from './expiry';

export interface StaleCheck {
  stale: boolean;
  reason?: string;
}

export function isOptimizationStale(
  result: OptimizationResult,
  room: Pick<MeetingRoom, 'status' | 'expiresAt' | 'decisionVersion'>,
  participants: Participant[],
  now: Date = new Date(),
): StaleCheck {
  if (room.status === 'finalized') {
    return { stale: true, reason: 'This meeting has been finalized since this search ran.' };
  }
  if (room.status === 'expired' || isRoomExpired(room, now)) {
    return { stale: true, reason: 'This meeting has expired since this search ran.' };
  }
  if (result.decisionVersion === null) {
    // No version stamp: the result cannot be proven current, so it
    // must not be treated as fresh. Callers always stamp a version.
    return {
      stale: true,
      reason: 'This search has no decision version stamp, so it cannot be verified as current. Re-run the search.',
    };
  }
  if (result.decisionVersion !== room.decisionVersion) {
    return {
      stale: true,
      reason: 'The room changed since this search ran (a newer decision exists).',
    };
  }
  if (result.participantsSignature !== signatureFromParticipants(participants)) {
    return {
      stale: true,
      reason: 'Participants or locations changed since this search ran.',
    };
  }
  const expired = participants.filter(
    (p) => p.location && Number.isFinite(new Date(p.location.expiresAt).getTime()) && new Date(p.location.expiresAt).getTime() <= now.getTime(),
  );
  if (expired.length > 0) {
    return {
      stale: true,
      reason: `Locations have expired for: ${expired.map((p) => p.displayName).join(', ')}.`,
    };
  }
  return { stale: false };
}
