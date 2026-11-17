import type { RoomStatus, TravelMode } from '../types';

/**
 * Optimization engine types (pure core).
 *
 * The engine ranks real meeting places by ROAD travel time from the
 * OSRM routing endpoint. It never computes a travel time from
 * straight-line distance: straight-line (haversine) distance is used
 * ONLY to draw search-area circles and to pre-filter candidates before
 * routing (geometry, not travel time). See ENGINE.md for the boundary
 * and src/engine/searchAreas.ts for the exact call sites.
 *
 * This module is pure: types only, no fetch, no window, no Supabase.
 */

export type OptimizationPreference = 'minTotal' | 'minimax' | 'balanced';

export type MeetingCategory =
  | 'cafe'
  | 'restaurant'
  | 'bar'
  | 'park'
  | 'library'
  | 'coworking'
  | 'fastFood'
  | 'mall'
  | 'metroStation'
  | 'railwayStation'
  | 'marketplace'
  | 'teaStall'
  | 'any';

export const OPTIMIZATION_PREFERENCES: OptimizationPreference[] = ['minTotal', 'minimax', 'balanced'];

export const PREFERENCE_LABELS: Record<OptimizationPreference, string> = {
  minTotal: 'Minimum total travel time',
  minimax: 'Fairest (shortest longest trip)',
  balanced: 'Balanced score',
};

export const MEETING_CATEGORIES: MeetingCategory[] = [
  'cafe',
  'restaurant',
  'bar',
  'park',
  'library',
  'coworking',
  'fastFood',
  'mall',
  'metroStation',
  'railwayStation',
  'marketplace',
  'teaStall',
  'any',
];

export const CATEGORY_LABELS: Record<MeetingCategory, string> = {
  cafe: 'Café',
  restaurant: 'Restaurant',
  bar: 'Bar / pub',
  park: 'Park',
  library: 'Library',
  coworking: 'Coworking',
  fastFood: 'Fast food',
  mall: 'Mall',
  metroStation: 'Metro station',
  railwayStation: 'Railway station',
  marketplace: 'Marketplace',
  teaStall: 'Tea stall',
  any: 'Anywhere to meet',
};

/** One participant's starting point for a search. Coordinates are required: an origin without a fresh location is never invented. */
export interface ParticipantOrigin {
  participantId: string;
  displayName: string;
  lat: number;
  lng: number;
  mode: TravelMode;
  /** Required participants must all be reachable; optional ones are reported but never exclude a candidate. */
  required: boolean;
  locationUpdatedAt: string;
  locationExpiresAt: string;
  /**
   * Consent to use this location for this search. For the person running
   * the search this comes from an explicit checkbox (their coordinates
   * leave the browser to the places/routing endpoints). For other room
   * members it reflects the room consent model: sharing a location in
   * the room opts into meeting-point search. See ENGINE.md.
   */
  consentGiven: boolean;
}

/** A real place discovered from OpenStreetMap data. Identity is the OSM type+id (e.g. 'node/123456'). */
export interface CandidatePlace {
  /** OSM identity, e.g. 'node/123', 'way/456', 'relation/789'. Mock places use 'mock/<id>'. */
  osmId: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  address?: string;
  /** Raw OSM tags, kept for debugging/labels. Never shown raw in the UI. */
  tags?: Record<string, string>;
  /** Where the place came from: 'overpass'/'photon' (live OSM data) or 'mock' (demo spots). */
  source: 'overpass' | 'photon' | 'mock';
}

/** One road-network travel result. `source` is 'osrm' for live routes and 'demo' for deterministic demo estimates. Never mixed. */
export interface TravelResult {
  participantId: string;
  candidateId: string;
  mode: TravelMode;
  /** Road travel time in minutes. Only present when reachable. */
  durationMin: number | null;
  /** Road distance in metres. Only present when reachable. */
  distanceM: number | null;
  reachable: boolean;
  source: 'osrm' | 'demo';
  /** [lng, lat] road geometry when the routing endpoint returned one. */
  geometry?: number[][];
}

/** A candidate with its per-participant results, aggregate stats, score, and explanation. Lower score is always better. */
export interface ScoredCandidate {
  candidate: CandidatePlace;
  perParticipant: TravelResult[];
  /** Sum of required participants' durations. */
  totalMin: number;
  /** Mean of required participants' durations. */
  averageMin: number;
  /** Longest required participant's duration. */
  maxMin: number;
  /** Population standard deviation of required participants' durations. */
  stdDevMin: number;
  /** Strategy score (lower is better). See src/engine/scoring.ts. */
  score: number;
  rank: number;
  explanation: string;
}

export interface ExcludedCandidate {
  candidate: CandidatePlace;
  reason: string;
}

/** One deterministic search circle: centre + radius in kilometres. */
export interface SearchArea {
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  reason: string;
}

export interface OptimizationInput {
  roomId: string;
  roomStatus: RoomStatus;
  /** The participant running the search (must be a room member). */
  currentParticipantId: string;
  /** All room member participant ids (membership check). */
  memberParticipantIds: string[];
  /** Participant ids that MUST have a fresh origin. Defaults to all members when omitted by callers that pass origins for everyone. */
  requiredParticipantIds?: string[];
  origins: ParticipantOrigin[];
  category: MeetingCategory;
  /** ISO 8601 meeting time. Validated and echoed; OSRM has no traffic/departure model, so durations are static. */
  meetingTimeISO: string;
  preference: OptimizationPreference;
  /** Optional cap: candidates are excluded when any required duration exceeds this (minutes, 5..240). */
  maxTravelMinutes?: number;
  /** Max candidates to route (after pre-filter). Default 12, hard cap 20. */
  maxCandidates?: number;
  /** Room decision version at search time, stamped onto the result for stale detection (see coordination/staleGuard.ts). */
  decisionVersion?: number;
}

export type EngineProvider = 'osrm' | 'demo';

export interface OptimizationStats {
  discovered: number;
  duplicatesRemoved: number;
  invalidRemoved: number;
  considered: number;
  /** Unique (origin, candidate, profile) route requests issued (cache hits included in the count as pairs, not network calls). */
  routePairs: number;
  /** Route requests that failed at the routing endpoint. */
  routeFailures: number;
  /** Overpass endpoint URL that served the place search (live mode only; the first area's endpoint when areas differ). */
  placesEndpoint?: string;
}

export interface OptimizationResult {
  ranked: ScoredCandidate[];
  excluded: ExcludedCandidate[];
  searchAreas: SearchArea[];
  warnings: string[];
  provider: EngineProvider;
  generatedAt: string;
  meetingTimeISO: string;
  preference: OptimizationPreference;
  category: MeetingCategory;
  stats: OptimizationStats;
  /** Room decision version at search time (null when the caller did not supply one). */
  decisionVersion: number | null;
  /** Fingerprint of the participants + location freshness at search time (see src/engine/signature.ts). */
  participantsSignature: string;
}
