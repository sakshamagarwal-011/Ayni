/**
 * Arrival confirmation helpers. Pure.
 *
 * Arrival is optional and reversible: a participant taps "I've arrived"
 * once they reach the destination, and can tap again to clear it.
 * Only the participant themselves may set/clear their own arrival
 * (enforced by RLS + auth in Supabase mode, by the current-participant
 * check in demo mode). Arrival changes flow through the existing
 * participants Realtime subscription.
 */
import type { Participant } from '../types';

export interface ArrivalSummary {
  arrivedCount: number;
  totalCount: number;
  arrivedNames: string[];
}

export function arrivalSummary(participants: Participant[]): ArrivalSummary {
  const arrived = participants.filter((p) => p.arrivedAt !== null);
  return {
    arrivedCount: arrived.length,
    totalCount: participants.length,
    arrivedNames: arrived.map((p) => p.displayName),
  };
}

export function arrivalLabel(participant: Pick<Participant, 'arrivedAt'>): string {
  return participant.arrivedAt !== null ? 'Arrived ✓' : 'On the way';
}
