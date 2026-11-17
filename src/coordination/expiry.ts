/**
 * Expiry helpers. Pure.
 *
 * Room expiry rule: a room is expired when its status is 'expired', or
 * when `expiresAt` has passed AND the room is not finalized. Finalized
 * rooms are never auto-expired for display — every participant must
 * keep seeing the same finalized destination (server-side cleanup
 * prunes old finalized rooms by age instead; see COORDINATION.md).
 *
 * Expired participant locations are excluded from ETA, optimization
 * and tally inputs, and shown as "Location expired" — never with
 * precise coordinates in new ETA/navigation UI.
 */
import type { MeetingRoom, Participant } from '../types';

export function isRoomExpired(
  room: Pick<MeetingRoom, 'status' | 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  if (room.status === 'expired') return true;
  if (room.status === 'finalized') return false;
  const expiresMs = new Date(room.expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs <= now.getTime();
}

export interface ExpiryInfo {
  expired: boolean;
  msRemaining: number;
  /** "Expires in 3 h 12 min", "Expires in 45 min", or "Expired". */
  label: string;
}

export function timeUntilExpiry(
  room: Pick<MeetingRoom, 'status' | 'expiresAt'>,
  now: Date = new Date(),
): ExpiryInfo {
  if (isRoomExpired(room, now)) {
    return { expired: true, msRemaining: 0, label: 'Expired' };
  }
  const msRemaining = Math.max(0, new Date(room.expiresAt).getTime() - now.getTime());
  const totalMin = Math.round(msRemaining / 60000);
  if (totalMin < 60) {
    return { expired: false, msRemaining, label: `Expires in ${totalMin} min` };
  }
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  const label = mins === 0 ? `Expires in ${hours} h` : `Expires in ${hours} h ${mins} min`;
  return { expired: false, msRemaining, label };
}

/** True when the participant has a location whose expiry is in the future. */
export function hasFreshLocation(participant: Pick<Participant, 'location'>, now: Date = new Date()): boolean {
  if (!participant.location) return false;
  const expiresMs = new Date(participant.location.expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs > now.getTime();
}

/** Participants with fresh (non-expired) locations. */
export function freshParticipants<T extends Pick<Participant, 'location'>>(participants: T[], now: Date = new Date()): T[] {
  return participants.filter((p) => hasFreshLocation(p, now));
}

export function expiredLocationMessage(): string {
  return 'Location expired — ask them to update';
}
