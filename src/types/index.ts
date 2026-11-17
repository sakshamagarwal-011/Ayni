export type TravelMode = 'walk' | 'scooter' | 'car' | 'transit';

export type RoomStatus = 'lobby' | 'discovering' | 'comparing' | 'finalized' | 'expired';

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface Friend {
  id: string;
  name: string;
  color: string;
  /** Tailwind-safe gradient classes, stored as full class names. */
  gradientClass: string;
  area: string;
  location: Coordinates;
}

export interface MeetingSpot {
  id: string;
  name: string;
  category: string;
  address: string;
  location: Coordinates;
  rating: number;
  priceLevel: 1 | 2 | 3;
  openNow: boolean;
  source: string;
  /**
   * OSM identity ('node/123', …) for spots published from a live
   * search (source 'live'). Absent/null for seeded/demo spots.
   * Added in migration 0008; null for older rows.
   */
  osmId?: string | null;
  /**
   * Rank (1..5) of this spot in the room's LATEST published batch,
   * or null when the spot is not in the latest batch. Owned by the
   * publish-results Edge Function; a re-publish supersedes the
   * previous batch. Drives the shared compared-set ordering (see
   * selectComparedSpots). Added in migration 0009; null for older
   * rows and for seeded/demo spots.
   */
  publishedRank: number | null;
}

export interface Participant {
  id: string;
  roomId: string;
  authUid: string | null;
  displayName: string;
  avatarColor: string;
  isHost: boolean;
  isReady: boolean;
  joinedAt: string;
  lastSeenAt: string;
  /** ISO timestamp when the participant confirmed arrival, or null. Added in migration 0005; null for older rows. */
  arrivedAt: string | null;
  location: ParticipantLocation | null;
}

export interface ParticipantLocation {
  id: string;
  participantId: string;
  roomId: string;
  lat: number;
  lng: number;
  label: string;
  accuracyM: number | null;
  updatedAt: string;
  expiresAt: string;
}

export interface MeetingRoom {
  id: string;
  inviteCode: string;
  title: string;
  hostAuthUid: string | null;
  status: RoomStatus;
  finalizedSpotId: string | null;
  /** Optimistic-lock counter for decisions. Starts at 1, increments on every finalize. Added in migration 0005; defaults to 1 for older rows. */
  decisionVersion: number;
  /** ISO timestamp when the meeting was finalized, or null. Added in migration 0005. */
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface RoomDetail {
  room: MeetingRoom;
  participants: Participant[];
  spots: MeetingSpot[];
  currentParticipantId: string | null;
}

/**
 * Where a route's distance/time/geometry came from. Never present
 * 'estimated'/'mock' data as a live road route in the UI.
 * - 'osrm': road route from the configured OSRM endpoint (development).
 * - 'estimated': haversine fallback after an OSRM failure.
 * - 'mock': deterministic demo estimate (default provider, no network).
 */
export type RouteSource = 'osrm' | 'estimated' | 'mock';

export interface RouteEstimate {
  id: string;
  roomId: string;
  participantId: string;
  spotId: string;
  mode: TravelMode;
  distanceM: number;
  durationMin: number;
  /** Optional [lng, lat] polyline (GeoJSON order). Straight line for estimates. */
  geometry?: number[][];
  /** Optional provenance; absent on older stored rows means 'estimated'. */
  source?: RouteSource;
}

export interface Vote {
  id: string;
  roomId: string;
  participantId: string;
  spotId: string;
  rank: number;
}

export interface CreateRoomInput {
  title: string;
  displayName: string;
  location: Coordinates;
  locationLabel: string;
  /** GPS fix accuracy in metres, when the location came from GPS. Persisted on the location row. */
  accuracyM?: number | null;
}

export interface JoinRoomInput {
  inviteCode: string;
  displayName: string;
  location: Coordinates;
  locationLabel: string;
  /** GPS fix accuracy in metres, when the location came from GPS. Persisted on the location row. */
  accuracyM?: number | null;
}

export interface UpdateLocationInput {
  roomId: string;
  lat: number;
  lng: number;
  label: string;
  /** GPS fix accuracy in metres, when the location came from GPS. Persisted on the location row. */
  accuracyM?: number | null;
}

export interface ServiceResult<T> {
  data: T;
}

export type ServiceMode = 'demo' | 'supabase';

export type RealtimeStatus = 'connecting' | 'connected' | 'error' | 'demo' | 'reconnecting' | 'offline';
