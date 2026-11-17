import {
  CoordinationError,
  coordinationErrorFromEdge,
  inferCoordinationCode,
  isActionAllowed,
  isCoordinationErrorCode,
  isRoomExpired,
  parseEdgeFunctionError,
  validateVoteSubmission,
} from '../coordination';
import { createResilientSubscription, type ChannelStatus } from '../coordination/reconnect';
import { buildAllRouteEstimates } from '../lib/distance';
import { ensureAnonymousAuth, getSupabaseClient } from '../lib/supabaseClient';
import { normalizeInviteCode } from '../lib/validation';
import type {
  CreateRoomInput,
  JoinRoomInput,
  MeetingSpot,
  Participant,
  RoomDetail,
  RouteEstimate,
  UpdateLocationInput,
  Vote,
} from '../types';
import { RoomNotFoundError, RoomServiceError, type RoomService } from './types';
import type { SubscriptionStatus } from '../coordination/reconnect';

/* Database row shapes (snake_case) — mapped to camelCase app types. */

interface RoomRow {
  id: string;
  invite_code: string;
  title: string;
  host_auth_uid: string | null;
  status: string;
  finalized_spot_id: string | null;
  decision_version?: number | null;
  finalized_at?: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface ParticipantRow {
  id: string;
  room_id: string;
  auth_uid: string;
  display_name: string;
  avatar_color: string;
  is_host: boolean;
  is_ready: boolean;
  arrived_at?: string | null;
  joined_at: string;
  last_seen_at: string;
}

interface LocationRow {
  id: string;
  participant_id: string;
  room_id: string;
  lat: number;
  lng: number;
  label: string;
  accuracy_m: number | null;
  updated_at: string;
  expires_at: string;
}

interface SpotRow {
  id: string;
  room_id: string;
  name: string;
  category: string;
  address: string;
  lat: number;
  lng: number;
  rating: number;
  price_level: number;
  open_now: boolean;
  source: string;
}

interface VoteRow {
  id: string;
  room_id: string;
  participant_id: string;
  spot_id: string;
  rank: number;
  created_at: string;
}

const LAST_CODE_KEY = 'meetsync-last-code-hint';
const NAME_KEY = 'meetsync-display-name-draft';

function setLastCodeHint(code: string): void {
  try {
    localStorage.setItem(LAST_CODE_KEY, code);
  } catch {
    // best-effort
  }
}

function setNameDraft(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // best-effort
  }
}

function mapRoom(row: RoomRow): RoomDetail['room'] {
  return {
    id: row.id,
    inviteCode: row.invite_code,
    title: row.title,
    hostAuthUid: row.host_auth_uid,
    status: row.status as RoomDetail['room']['status'],
    finalizedSpotId: row.finalized_spot_id,
    // Defaults keep old rows (pre-migration-0005) working.
    decisionVersion: row.decision_version ?? 1,
    finalizedAt: row.finalized_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function mapVote(row: VoteRow): Vote {
  return {
    id: row.id,
    roomId: row.room_id,
    participantId: row.participant_id,
    spotId: row.spot_id,
    rank: row.rank,
  };
}

export class SupabaseRoomService implements RoomService {
  readonly mode = 'supabase' as const;

  async ensureAuth(): Promise<{ userId: string | null }> {
    const { userId } = await ensureAnonymousAuth();
    return { userId };
  }

  private requireClient() {
    const client = getSupabaseClient();
    if (!client) throw new RoomServiceError('Supabase is not configured.');
    return client;
  }

  /** Throw a typed CoordinationError for an Edge Function payload error ({ error, code }). */
  private payloadError(payload: { error?: string; code?: unknown } | null, fallback: string): CoordinationError {
    const message = payload?.error ?? fallback;
    const code = isCoordinationErrorCode(payload?.code) ? payload.code : inferCoordinationCode(message);
    return new CoordinationError(code, message);
  }

  async createRoom(input: CreateRoomInput): Promise<RoomDetail> {
    await this.ensureAuth();
    const supabase = this.requireClient();
    const { data, error } = await supabase.functions.invoke('create-room', {
      body: {
        title: input.title,
        displayName: input.displayName,
        lat: input.location.lat,
        lng: input.location.lng,
        label: input.locationLabel,
      },
    });
    if (error) throw new RoomServiceError(error.message);
    const payload = data as { inviteCode?: string; error?: string };
    if (payload?.error || !payload?.inviteCode) {
      throw new RoomServiceError(payload?.error ?? 'Failed to create room.');
    }
    setNameDraft(input.displayName);
    setLastCodeHint(payload.inviteCode);
    const detail = await this.getRoomByCode(payload.inviteCode);
    if (!detail) throw new RoomServiceError('Room was created but could not be loaded. Try joining with the invite code.');
    return detail;
  }

  async joinRoom(input: JoinRoomInput): Promise<RoomDetail> {
    await this.ensureAuth();
    const supabase = this.requireClient();
    const code = normalizeInviteCode(input.inviteCode);
    const { data, error } = await supabase.functions.invoke('join-room', {
      body: { inviteCode: code, displayName: input.displayName },
    });
    if (error) {
      const parsed = await parseEdgeFunctionError(error);
      if (parsed.status === 410) {
        throw new CoordinationError('EXPIRED', parsed.message ?? 'This meeting link has expired.');
      }
      if (parsed.status === 404) throw new RoomNotFoundError(code);
      throw new RoomServiceError(parsed.message ?? error.message);
    }
    const payload = data as { room?: { id: string }; error?: string; code?: unknown };
    if (payload?.error || !payload?.room) {
      if (payload?.error && payload.error.toLowerCase().includes('expired')) {
        throw new CoordinationError('EXPIRED', payload.error);
      }
      throw new RoomNotFoundError(code);
    }
    // Join does not carry location; update it via its own Edge Function.
    // Joining a finalized room is allowed (view-only); location updates
    // are permitted in finalized rooms for navigation.
    const { error: locError } = await supabase.functions.invoke('update-location', {
      body: { roomId: payload.room.id, lat: input.location.lat, lng: input.location.lng, label: input.locationLabel },
    });
    if (locError) throw new RoomServiceError(`Joined, but location update failed: ${locError.message}`);
    setNameDraft(input.displayName);
    setLastCodeHint(code);
    const detail = await this.getRoomByCode(code);
    if (!detail) throw new RoomNotFoundError(code);
    return detail;
  }

  private async loadDetail(roomRow: RoomRow, currentUserId: string | null): Promise<RoomDetail> {
    const supabase = this.requireClient();
    const roomId = roomRow.id;
    const [participantsRes, locationsRes, spotsRes] = await Promise.all([
      supabase.from('participants').select('*').eq('room_id', roomId).order('joined_at', { ascending: true }),
      supabase.from('participant_locations').select('*').eq('room_id', roomId),
      supabase.from('candidate_spots').select('*').eq('room_id', roomId).order('created_at', { ascending: true }),
    ]);
    if (participantsRes.error) throw new RoomServiceError(participantsRes.error.message);
    if (locationsRes.error) throw new RoomServiceError(locationsRes.error.message);
    if (spotsRes.error) throw new RoomServiceError(spotsRes.error.message);

    const locationsByParticipant = new Map<string, LocationRow>();
    for (const row of (locationsRes.data ?? []) as LocationRow[]) {
      locationsByParticipant.set(row.participant_id, row);
    }
    const participants: Participant[] = ((participantsRes.data ?? []) as ParticipantRow[]).map((p) => {
      const loc = locationsByParticipant.get(p.id);
      return {
        id: p.id,
        roomId: p.room_id,
        authUid: p.auth_uid,
        displayName: p.display_name,
        avatarColor: p.avatar_color,
        isHost: p.is_host,
        isReady: p.is_ready,
        arrivedAt: p.arrived_at ?? null,
        joinedAt: p.joined_at,
        lastSeenAt: p.last_seen_at,
        location: loc
          ? {
              id: loc.id,
              participantId: loc.participant_id,
              roomId: loc.room_id,
              lat: loc.lat,
              lng: loc.lng,
              label: loc.label,
              accuracyM: loc.accuracy_m,
              updatedAt: loc.updated_at,
              expiresAt: loc.expires_at,
            }
          : null,
      };
    });
    const spots: MeetingSpot[] = ((spotsRes.data ?? []) as SpotRow[]).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      address: s.address,
      location: { lat: s.lat, lng: s.lng },
      rating: Number(s.rating),
      priceLevel: s.price_level as 1 | 2 | 3,
      openNow: s.open_now,
      source: s.source,
    }));
    const current = currentUserId
      ? participants.find((p) => p.authUid === currentUserId) ?? null
      : null;
    return {
      room: mapRoom(roomRow),
      participants,
      spots,
      currentParticipantId: current?.id ?? null,
    };
  }

  async getRoomByCode(code: string): Promise<RoomDetail | null> {
    await this.ensureAuth();
    const supabase = this.requireClient();
    const normalized = normalizeInviteCode(code);
    const { data: userData } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('meeting_rooms')
      .select('*')
      .eq('invite_code', normalized)
      .maybeSingle();
    if (error) throw new RoomServiceError(error.message);
    if (!data) return null;
    return this.loadDetail(data as RoomRow, userData.user?.id ?? null);
  }

  async getRoomDetail(roomId: string): Promise<RoomDetail | null> {
    await this.ensureAuth();
    const supabase = this.requireClient();
    const { data: userData } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('meeting_rooms').select('*').eq('id', roomId).maybeSingle();
    if (error) throw new RoomServiceError(error.message);
    if (!data) return null;
    return this.loadDetail(data as RoomRow, userData.user?.id ?? null);
  }

  async updateLocation(input: UpdateLocationInput): Promise<void> {
    await this.ensureAuth();
    const supabase = this.requireClient();
    const { data, error } = await supabase.functions.invoke('update-location', {
      body: { roomId: input.roomId, lat: input.lat, lng: input.lng, label: input.label },
    });
    if (error) throw new RoomServiceError(error.message);
    const payload = data as { error?: string } | null;
    if (payload?.error) throw new RoomServiceError(payload.error);
  }

  async setReady(roomId: string, participantId: string, ready: boolean): Promise<void> {
    const { userId } = await this.ensureAuth();
    const supabase = this.requireClient();
    void roomId;
    const { error } = await supabase
      .from('participants')
      .update({ is_ready: ready, last_seen_at: new Date().toISOString() })
      .eq('id', participantId)
      .eq('auth_uid', userId);
    if (error) throw new RoomServiceError(error.message);
  }

  async confirmArrival(roomId: string, participantId: string, arrived: boolean): Promise<void> {
    const { userId } = await this.ensureAuth();
    const supabase = this.requireClient();
    const detail = await this.getRoomDetail(roomId);
    if (!detail) throw new RoomServiceError('Room not found.');
    const participant = detail.participants.find((p) => p.id === participantId);
    if (!participant || participant.authUid !== userId) {
      throw new CoordinationError('NOT_MEMBER', 'You can only confirm your own arrival.');
    }
    const check = isActionAllowed(detail.room.status, 'arrive', {
      isMember: true,
      isExpired: isRoomExpired(detail.room),
    });
    if (!check.allowed) {
      throw new CoordinationError(check.code ?? 'UNKNOWN', check.reason ?? 'Arrival cannot be confirmed.');
    }
    // RLS (participants_update_own + privilege trigger) enforces
    // self-only updates server-side too; arrived_at is an allowed
    // self-update column (migration 0005).
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('participants')
      .update({ arrived_at: arrived ? now : null, last_seen_at: now })
      .eq('id', participantId)
      .eq('auth_uid', userId)
      .select('id');
    if (error) throw new RoomServiceError(error.message);
    if (!data || data.length === 0) {
      throw new CoordinationError('NOT_MEMBER', 'You can only confirm your own arrival.');
    }
  }

  async getSpots(roomId: string): Promise<MeetingSpot[]> {
    const detail = await this.getRoomDetail(roomId);
    return detail?.spots ?? [];
  }

  async getRouteEstimates(roomId: string): Promise<RouteEstimate[]> {
    // Deterministic client-side estimates (same formula as demo mode).
    // The route_estimates table is reserved for future server-computed
    // estimates; no live routing provider is connected yet.
    const detail = await this.getRoomDetail(roomId);
    if (!detail) return [];
    return buildAllRouteEstimates(roomId, detail.participants, detail.spots);
  }

  async submitVotes(roomId: string, participantId: string, rankedSpotIds: string[]): Promise<Vote[]> {
    const { userId } = await this.ensureAuth();
    const supabase = this.requireClient();
    const detail = await this.getRoomDetail(roomId);
    if (!detail) throw new RoomServiceError('Room not found.');
    const participant = detail.participants.find((p) => p.id === participantId);
    if (!participant || participant.authUid !== userId) {
      throw new CoordinationError('NOT_MEMBER', 'You can only vote as yourself.');
    }
    const check = isActionAllowed(detail.room.status, 'vote', {
      isMember: true,
      isExpired: isRoomExpired(detail.room),
    });
    if (!check.allowed) {
      throw new CoordinationError(check.code ?? 'UNKNOWN', check.reason ?? 'Voting is not allowed.');
    }
    const issues = validateVoteSubmission(
      rankedSpotIds,
      detail.spots.map((s) => s.id),
    );
    if (issues.length > 0) {
      throw new CoordinationError('VOTE_FAILED', issues.join(' '));
    }
    // One active ranking: delete the previous votes, then insert the
    // new ranking. RLS (owns_participant) enforces self-only writes
    // server-side as well.
    const { error: delError } = await supabase.from('votes').delete().eq('participant_id', participantId).eq('room_id', roomId);
    if (delError) throw new RoomServiceError(delError.message);
    if (rankedSpotIds.length === 0) return [];
    const rows = rankedSpotIds.map((spotId, i) => ({
      room_id: roomId,
      participant_id: participantId,
      spot_id: spotId,
      rank: i + 1,
    }));
    const { error } = await supabase.from('votes').insert(rows).select('id');
    if (error) throw new RoomServiceError(error.message);
    // Refetch after save so the caller sees exactly what is stored.
    const { data, error: refetchError } = await supabase
      .from('votes')
      .select('*')
      .eq('room_id', roomId)
      .eq('participant_id', participantId)
      .order('rank', { ascending: true });
    if (refetchError) throw new RoomServiceError(refetchError.message);
    return ((data ?? []) as VoteRow[]).map(mapVote);
  }

  async getVotes(roomId: string): Promise<Vote[]> {
    await this.ensureAuth();
    const supabase = this.requireClient();
    const { data, error } = await supabase.from('votes').select('*').eq('room_id', roomId);
    if (error) throw new RoomServiceError(error.message);
    return ((data ?? []) as VoteRow[]).map(mapVote);
  }

  async finalizeMeeting(roomId: string, spotId: string, expectedDecisionVersion?: number): Promise<RoomDetail> {
    await this.ensureAuth();
    const supabase = this.requireClient();
    const { data, error } = await supabase.functions.invoke('finalize-meeting', {
      body: {
        roomId,
        spotId,
        ...(expectedDecisionVersion !== undefined ? { expectedDecisionVersion } : {}),
      },
    });
    if (error) {
      const parsed = await parseEdgeFunctionError(error);
      throw coordinationErrorFromEdge(parsed, 'Failed to finalize the meeting.');
    }
    const payload = data as { error?: string; code?: unknown } | null;
    if (payload?.error) throw this.payloadError(payload, 'Failed to finalize the meeting.');
    const detail = await this.getRoomDetail(roomId);
    if (!detail) throw new RoomServiceError('Meeting was finalized but the room could not be reloaded.');
    return detail;
  }

  subscribeToRoom(
    roomId: string,
    onChange: () => void,
    onStatus?: (status: SubscriptionStatus) => void,
  ): () => void {
    const supabase = getSupabaseClient();
    if (!supabase) {
      onStatus?.('error');
      return () => undefined;
    }
    const subscription = createResilientSubscription({
      createChannel: (handlers) => {
        const channel = supabase
          .channel(`room:${roomId}`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'participants', filter: `room_id=eq.${roomId}` },
            () => handlers.onEvent(),
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'meeting_rooms', filter: `id=eq.${roomId}` },
            () => handlers.onEvent(),
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'votes', filter: `room_id=eq.${roomId}` },
            () => handlers.onEvent(),
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'participant_locations', filter: `room_id=eq.${roomId}` },
            () => handlers.onEvent(),
          )
          .subscribe((status) => handlers.onStatus(status as ChannelStatus));
        return {
          unsubscribe: () => {
            void supabase.removeChannel(channel);
          },
        };
      },
      onChange,
      onStatus,
    });

    // Browser connectivity: report offline immediately, and reconnect
    // + refetch as soon as the device comes back online.
    let handleOnline: (() => void) | null = null;
    let handleOffline: (() => void) | null = null;
    if (typeof window !== 'undefined') {
      handleOnline = () => {
        subscription.reconnectNow();
        onChange();
      };
      handleOffline = () => {
        onStatus?.('offline');
      };
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }

    return () => {
      if (typeof window !== 'undefined') {
        if (handleOnline) window.removeEventListener('online', handleOnline);
        if (handleOffline) window.removeEventListener('offline', handleOffline);
      }
      subscription.unsubscribe();
    };
  }
}
