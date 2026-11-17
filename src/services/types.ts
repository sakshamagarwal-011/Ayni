import type { SubscriptionStatus } from '../coordination/reconnect';
import type {
  CreateRoomInput,
  JoinRoomInput,
  MeetingSpot,
  RoomDetail,
  RouteEstimate,
  ServiceMode,
  UpdateLocationInput,
  Vote,
} from '../types';

export type { SubscriptionStatus };

/**
 * Single service interface used by ALL pages.
 * Phase 1 (mock) and Phase 2 (Supabase) both implement this contract,
 * so the UI never changes structure when switching backends.
 *
 * Coordination rules (see COORDINATION.md) are enforced consistently
 * by both implementations and, in Supabase mode, again server-side:
 * - submitVotes replaces the participant's ranking (one active vote).
 * - finalizeMeeting is host-only and takes an optional expected
 *   decision version for optimistic locking.
 * - confirmArrival is self-only and only meaningful once finalized.
 * - subscribeToRoom watches participants, meeting_rooms, votes and
 *   participant_locations (Supabase mode; demo mode is a no-op).
 */
export interface RoomService {
  readonly mode: ServiceMode;

  ensureAuth(): Promise<{ userId: string | null }>;

  createRoom(input: CreateRoomInput): Promise<RoomDetail>;
  joinRoom(input: JoinRoomInput): Promise<RoomDetail>;
  getRoomByCode(code: string): Promise<RoomDetail | null>;
  getRoomDetail(roomId: string): Promise<RoomDetail | null>;

  updateLocation(input: UpdateLocationInput): Promise<void>;
  setReady(roomId: string, participantId: string, ready: boolean): Promise<void>;

  /** Optional arrival confirmation (self-only, reversible). */
  confirmArrival(roomId: string, participantId: string, arrived: boolean): Promise<void>;

  getSpots(roomId: string): Promise<MeetingSpot[]>;
  getRouteEstimates(roomId: string): Promise<RouteEstimate[]>;

  /**
   * Publish live search results as votable spots (max 5, ranked
   * order). Idempotent per OSM id: re-publishing the same place
   * updates its row and keeps its id, so votes are never stranded.
   * Bumps the room's decision_version, which propagates the new
   * spots to every open page via the room Realtime subscription.
   * Members only, open rooms only (see the 'publish' action rules).
   */
  publishResults(roomId: string, places: PublishPlaceInput[]): Promise<PublishResultsOutcome>;

  /** Rank spots: rank 1 = top choice. Replaces the participant's votes. */
  submitVotes(roomId: string, participantId: string, rankedSpotIds: string[]): Promise<Vote[]>;
  getVotes(roomId: string): Promise<Vote[]>;

  /**
   * Finalize to a spot. Host-only. When expectedDecisionVersion is
   * provided and does not match the room's current version, the call
   * fails with a stale-version error and nothing changes.
   */
  finalizeMeeting(roomId: string, spotId: string, expectedDecisionVersion?: number): Promise<RoomDetail>;

  /** Live room updates (participants, room, votes, locations). Returns an unsubscribe function. */
  subscribeToRoom(
    roomId: string,
    onChange: () => void,
    onStatus?: (status: SubscriptionStatus) => void,
  ): () => void;
}

export class RoomNotFoundError extends Error {
  constructor(code: string) {
    super(`No meeting room found for invite code "${code}". Check the code and try again.`);
    this.name = 'RoomNotFoundError';
  }
}
export class RoomServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomServiceError';
  }
}

/**
 * One live place to publish as a votable spot. Carries only what the
 * engine knows: OSM identity, name, category label, coordinates and
 * an optional address. Rating/price/open-now are deliberately absent
 * — live places have none, and inventing them would be fake data.
 */
export interface PublishPlaceInput {
  osmId: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  address?: string;
}

export interface PublishResultsOutcome {
  /** Upserted spots in submitted (ranked) order. */
  spots: MeetingSpot[];
  /** The room's decision_version after the publish bump. */
  decisionVersion: number;
}
