/**
 * Participant signature: a deterministic fingerprint of who was in a
 * search and how fresh each location was. Used to stamp optimization
 * results so stale results can be detected when the room changes
 * (new participant, location update, or a newer decision).
 *
 * Pure: no fetch, no window, no Supabase. Shared by the engine
 * orchestrator (stamping) and the coordination stale guard (checking)
 * so the two can never drift apart.
 */
import type { Participant } from '../types';
import type { ParticipantOrigin } from './types';

export interface SignatureEntry {
  participantId: string;
  /** ISO update timestamp of the location used, or null when no location was used. */
  locationUpdatedAt: string | null;
}

/** Canonical signature: entries sorted by participant id, joined with '|'. */
export function participantsSignature(entries: SignatureEntry[]): string {
  return [...entries]
    .sort((a, b) => a.participantId.localeCompare(b.participantId))
    .map((e) => `${e.participantId}:${e.locationUpdatedAt ?? 'none'}`)
    .join('|');
}

export function signatureFromOrigins(origins: ParticipantOrigin[]): string {
  return participantsSignature(
    origins.map((o) => ({ participantId: o.participantId, locationUpdatedAt: o.locationUpdatedAt })),
  );
}

export function signatureFromParticipants(participants: Participant[]): string {
  return participantsSignature(
    participants.map((p) => ({ participantId: p.id, locationUpdatedAt: p.location?.updatedAt ?? null })),
  );
}
