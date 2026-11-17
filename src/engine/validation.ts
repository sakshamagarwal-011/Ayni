import { OptimizationValidationError } from './errors';
import {
  MEETING_CATEGORIES,
  OPTIMIZATION_PREFERENCES,
  type OptimizationInput,
} from './types';

/**
 * Step 1 — validate membership, consent, coordinates, freshness, and
 * meeting state. Pure: returns every issue found (empty = valid).
 * The orchestrator turns a non-empty list into an
 * OptimizationValidationError; nothing here throws.
 */

const ALLOWED_STATUSES = ['lobby', 'discovering', 'comparing'] as const;
const MAX_PAST_MS = 24 * 60 * 60 * 1000;

function isFiniteCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function validateOptimizationInput(
  input: OptimizationInput,
  now: Date = new Date(),
): string[] {
  const issues: string[] = [];
  const nowMs = now.getTime();

  if (!input.roomId.trim()) issues.push('Room id is missing.');
  if (!ALLOWED_STATUSES.includes(input.roomStatus as (typeof ALLOWED_STATUSES)[number])) {
    issues.push(
      `This meeting is ${input.roomStatus}, so a new search cannot run. Searches run while the meeting is in the lobby, discovering, or comparing state.`,
    );
  }

  // Membership: the runner must be a member, and every origin must belong to a member.
  const members = new Set(input.memberParticipantIds);
  if (members.size === 0) {
    issues.push('Room membership could not be verified.');
  } else {
    if (!members.has(input.currentParticipantId)) {
      issues.push('You must join this room before running a search.');
    }
    for (const origin of input.origins) {
      if (!members.has(origin.participantId)) {
        issues.push(`${origin.displayName} is not a member of this room.`);
      }
    }
  }

  // Origins: at least one required origin; duplicates are an error (ambiguous identity).
  const seen = new Set<string>();
  for (const origin of input.origins) {
    if (seen.has(origin.participantId)) {
      issues.push(`${origin.displayName} appears more than once in this search.`);
    }
    seen.add(origin.participantId);
  }
  const requiredOrigins = input.origins.filter((o) => o.required);
  if (requiredOrigins.length === 0) {
    issues.push('At least one participant with a location is required to run a search.');
  }
  if (input.origins.length === 1) {
    // Warning-worthy, not blocking: recorded by the caller via validate warnings.
    // Kept out of `issues` deliberately — a solo search is allowed.
  }

  // Required participants must all have an origin (missing location = rejected, never defaulted).
  const requiredIds = input.requiredParticipantIds ?? input.memberParticipantIds;
  for (const id of requiredIds) {
    if (!seen.has(id)) {
      issues.push('A required participant has no location. Ask everyone to set a location, or remove them from the search.');
      break;
    }
  }

  // Per-origin checks: consent (required only), coordinates, freshness.
  const noConsent: string[] = [];
  const expired: string[] = [];
  for (const origin of input.origins) {
    if (!isFiniteCoord(origin.lat, origin.lng)) {
      issues.push(`${origin.displayName} has an invalid location. Ask them to set it again.`);
      continue;
    }
    if (origin.required && !origin.consentGiven) {
      noConsent.push(origin.displayName);
    }
    const expiresMs = new Date(origin.locationExpiresAt).getTime();
    if (!Number.isFinite(expiresMs)) {
      issues.push(`${origin.displayName} has a location with an unknown expiry time. Ask them to set it again.`);
    } else if (expiresMs <= nowMs) {
      expired.push(origin.displayName);
    }
    const updatedMs = new Date(origin.locationUpdatedAt).getTime();
    if (!Number.isFinite(updatedMs)) {
      issues.push(`${origin.displayName} has a location with an unknown update time. Ask them to set it again.`);
    }
  }
  if (noConsent.length > 0) {
    issues.push(
      `Location consent is missing for: ${noConsent.join(', ')}. Consent is required before locations are used for a search.`,
    );
  }
  if (expired.length > 0) {
    issues.push(
      `Locations have expired for: ${expired.join(', ')}. Ask them to update their location and try again.`,
    );
  }

  // Meeting time: valid ISO, not more than 24h in the past. Durations are
  // static (OSRM has no departure-time/traffic model) — see ENGINE.md.
  const meetingMs = new Date(input.meetingTimeISO).getTime();
  if (!Number.isFinite(meetingMs)) {
    issues.push('Meeting time must be a valid date and time.');
  } else if (meetingMs < nowMs - MAX_PAST_MS) {
    issues.push('Meeting time is more than 24 hours in the past.');
  }

  // Enums + constraints.
  if (!MEETING_CATEGORIES.includes(input.category)) {
    issues.push(`Unknown meeting category: ${String(input.category)}.`);
  }
  if (!OPTIMIZATION_PREFERENCES.includes(input.preference)) {
    issues.push(`Unknown optimization preference: ${String(input.preference)}.`);
  }
  if (input.maxTravelMinutes !== undefined) {
    if (!Number.isFinite(input.maxTravelMinutes) || input.maxTravelMinutes < 5 || input.maxTravelMinutes > 240) {
      issues.push('Maximum travel time must be between 5 and 240 minutes.');
    }
  }
  if (input.maxCandidates !== undefined) {
    if (!Number.isInteger(input.maxCandidates) || input.maxCandidates < 1 || input.maxCandidates > 20) {
      issues.push('Maximum candidates must be a whole number between 1 and 20.');
    }
  }

  return issues;
}

/** Non-blocking warnings for an otherwise valid input (solo search, far-future time, ...). */
export function optimizationWarnings(input: OptimizationInput, now: Date = new Date()): string[] {
  const warnings: string[] = [];
  if (input.origins.length === 1) {
    warnings.push('Only one participant has a location, so results are ranked for that person alone.');
  }
  const meetingMs = new Date(input.meetingTimeISO).getTime();
  if (Number.isFinite(meetingMs) && meetingMs > now.getTime() + 30 * 24 * 60 * 60 * 1000) {
    warnings.push('Meeting time is more than 30 days away. Travel times are static estimates with no traffic model.');
  }
  return warnings;
}

/** Throwing convenience wrapper for callers that want fail-fast behaviour. */
export function assertValidOptimizationInput(input: OptimizationInput, now: Date = new Date()): void {
  const issues = validateOptimizationInput(input, now);
  if (issues.length > 0) throw new OptimizationValidationError(issues);
}
