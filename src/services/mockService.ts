import {
  CoordinationError,
  isActionAllowed,
  isRoomExpired,
  validateVoteSubmission,
} from '../coordination';
import { AVATAR_COLORS, DEMO_INVITE_CODE, MOCK_FRIENDS, MOCK_SPOTS } from '../data/mockData';
import { buildAllRouteEstimates } from '../lib/distance';
import { delay } from '../lib/utils';
import { INVITE_ALPHABET, normalizeInviteCode, validateDisplayName, validateTitle } from '../lib/validation';
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

const STORE_KEY = 'meetsync-demo-rooms-v1';
const CURRENT_KEY = 'meetsync-demo-current-v1';
const NAME_KEY = 'meetsync-display-name-draft';
const LAST_CODE_KEY = 'meetsync-last-code-hint';

/**
 * Minimal key/value storage. The browser default is localStorage; tests
 * inject a shared in-memory store so two service instances can read
 * and write the same rooms (see tests/integration/coordination.test.ts).
 * In non-browser environments (vitest/node) without an injected store,
 * a module-level in-memory store is used so the service still works.
 */
export interface MockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createMemoryMockStorage(): MockStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

let sharedFallbackStorage: MockStorage | null = null;

function defaultMockStorage(): MockStorage {
  if (typeof localStorage !== 'undefined') {
    return localStorage;
  }
  if (!sharedFallbackStorage) sharedFallbackStorage = createMemoryMockStorage();
  return sharedFallbackStorage;
}

interface StoredRoom {
  detail: RoomDetail;
  votes: Vote[];
}

/**
 * Fill in fields added by later versions (decisionVersion, finalizedAt,
 * arrivedAt) so rooms persisted by older builds keep working.
 */
function normalizeDetail(detail: RoomDetail): RoomDetail {
  const room = detail.room as Partial<RoomDetail['room']>;
  if (typeof room.decisionVersion !== 'number') room.decisionVersion = 1;
  if (room.finalizedAt === undefined) room.finalizedAt = null;
  for (const p of detail.participants) {
    if ((p as Partial<Participant>).arrivedAt === undefined) p.arrivedAt = null;
  }
  return detail;
}

function loadStoreFrom(storage: MockStorage): Record<string, StoredRoom> {
  try {
    const raw = storage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, StoredRoom>) : {};
    for (const stored of Object.values(parsed)) {
      if (stored?.detail) normalizeDetail(stored.detail);
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveStoreTo(storage: MockStorage, store: Record<string, StoredRoom>): void {
  try {
    storage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Demo persistence is best-effort.
  }
}

function loadCurrentFrom(storage: MockStorage): Record<string, string> {
  try {
    const raw = storage.getItem(CURRENT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveCurrentTo(storage: MockStorage, map: Record<string, string>): void {
  try {
    storage.setItem(CURRENT_KEY, JSON.stringify(map));
  } catch {
    // best-effort
  }
}

export function getDisplayNameDraft(): string {
  try {
    return defaultMockStorage().getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Last invite code used in this browser (create/join hint for the Join form). */
export function getLastCodeHint(): string | null {
  try {
    return defaultMockStorage().getItem(LAST_CODE_KEY);
  } catch {
    return null;
  }
}

function setLastCodeHint(code: string): void {
  try {
    defaultMockStorage().setItem(LAST_CODE_KEY, code);
  } catch {
    // best-effort
  }
}

export function setDisplayNameDraft(name: string): void {
  try {
    defaultMockStorage().setItem(NAME_KEY, name);
  } catch {
    // best-effort
  }
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function generateInviteCode(existing: Set<string>): string {
  const bytes = new Uint8Array(6);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    crypto.getRandomValues(bytes);
    const code = Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
    if (!existing.has(code)) return code;
  }
  return DEMO_INVITE_CODE;
}

function cloneSpots(): MeetingSpot[] {
  return MOCK_SPOTS.map((s) => ({ ...s, location: { ...s.location } }));
}

function friendParticipants(roomId: string, excludeCount = 0): Participant[] {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  return MOCK_FRIENDS.slice(0, MOCK_FRIENDS.length - excludeCount).map((f, i) => {
    const pid = newId('participant');
    return {
      id: pid,
      roomId,
      authUid: null,
      displayName: f.name,
      avatarColor: f.color,
      isHost: false,
      isReady: i === 0,
      joinedAt: now,
      lastSeenAt: now,
      arrivedAt: null,
      location: {
        id: newId('location'),
        participantId: pid,
        roomId,
        lat: f.location.lat,
        lng: f.location.lng,
        label: f.area,
        accuracyM: 25,
        updatedAt: now,
        expiresAt: expires,
      },
    };
  });
}

function seedDemoRoomIfNeeded(store: Record<string, StoredRoom>): void {
  if (store[DEMO_INVITE_CODE]) return;
  const roomId = newId('room');
  const now = new Date().toISOString();
  const friends = friendParticipants(roomId);
  store[DEMO_INVITE_CODE] = {
    detail: {
      room: {
        id: roomId,
        inviteCode: DEMO_INVITE_CODE,
        title: 'Weekend Brunch Meetup',
        hostAuthUid: null,
        status: 'lobby',
        finalizedSpotId: null,
        decisionVersion: 1,
        finalizedAt: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      participants: friends,
      spots: cloneSpots(),
      currentParticipantId: null,
    },
    votes: [],
  };
}

/**
 * Demo-only expiry cleanup (localStorage only, no network): mark
 * past-expires_at open rooms 'expired' and delete rooms expired more
 * than 7 days ago. Mirrors expire_rooms() + the cleanup Edge Function's
 * retention rule. Best-effort; failures are swallowed by callers.
 */
export function purgeExpiredDemoRooms(storage?: MockStorage): { expired: number; pruned: number } {
  const store = loadStoreFrom(storage ?? defaultMockStorage());
  const now = Date.now();
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  let expired = 0;
  let pruned = 0;
  let changed = false;
  for (const [code, stored] of Object.entries(store)) {
    const room = stored.detail.room;
    const expiresMs = new Date(room.expiresAt).getTime();
    if (Number.isFinite(expiresMs) && expiresMs < cutoff) {
      delete store[code];
      pruned += 1;
      changed = true;
      continue;
    }
    if (room.status !== 'finalized' && room.status !== 'expired' && isRoomExpired(room, new Date(now))) {
      room.status = 'expired';
      room.updatedAt = new Date(now).toISOString();
      expired += 1;
      changed = true;
    }
  }
  if (changed) saveStoreTo(storage ?? defaultMockStorage(), store);
  return { expired, pruned };
}

export class MockRoomService implements RoomService {
  readonly mode = 'demo' as const;
  private readonly storage: MockStorage;
  /**
   * Per-browser identity storage (the current-participant map). In a
   * real browser this is the same localStorage as the room store: one
   * browser = one identity per room. Tests inject a SEPARATE identity
   * store per service instance to simulate distinct browsers sharing
   * one room store.
   */
  private readonly identityStorage: MockStorage;

  constructor(storage?: MockStorage, identityStorage?: MockStorage) {
    this.storage = storage ?? defaultMockStorage();
    this.identityStorage = identityStorage ?? this.storage;
    // Best-effort demo-only cleanup on load (localStorage only, no
    // network): mark expired rooms, prune rooms expired > 7 days ago.
    this.purgeBestEffort();
  }

  private loadStore(): Record<string, StoredRoom> {
    return loadStoreFrom(this.storage);
  }

  private saveStore(store: Record<string, StoredRoom>): void {
    saveStoreTo(this.storage, store);
  }

  private loadCurrent(): Record<string, string> {
    return loadCurrentFrom(this.identityStorage);
  }

  private saveCurrent(map: Record<string, string>): void {
    saveCurrentTo(this.identityStorage, map);
  }

  private purgeBestEffort(): void {
    try {
      purgeExpiredDemoRooms(this.storage);
    } catch {
      // Demo cleanup must never break reads.
    }
  }

  async ensureAuth(): Promise<{ userId: string | null }> {
    return { userId: null };
  }

  async createRoom(input: CreateRoomInput): Promise<RoomDetail> {
    await delay(600);
    const titleError = validateTitle(input.title);
    if (titleError) throw new RoomServiceError(titleError);
    const nameError = validateDisplayName(input.displayName);
    if (nameError) throw new RoomServiceError(nameError);
    setDisplayNameDraft(input.displayName);

    this.purgeBestEffort();
    const store = this.loadStore();
    seedDemoRoomIfNeeded(store);
    const code = generateInviteCode(new Set(Object.keys(store)));
    const roomId = newId('room');
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const hostId = newId('participant');
    const host: Participant = {
      id: hostId,
      roomId,
      authUid: null,
      displayName: input.displayName.trim(),
      avatarColor: AVATAR_COLORS[0],
      isHost: true,
      isReady: false,
      joinedAt: now,
      lastSeenAt: now,
      arrivedAt: null,
      location: {
        id: newId('location'),
        participantId: hostId,
        roomId,
        lat: input.location.lat,
        lng: input.location.lng,
        label: input.locationLabel.trim(),
        accuracyM: input.accuracyM ?? 20,
        updatedAt: now,
        expiresAt: expires,
      },
    };
    // Seed 3 friends so routes/comparison feel real in demo mode.
    const friends = friendParticipants(roomId).slice(0, 3);
    const detail: RoomDetail = {
      room: {
        id: roomId,
        inviteCode: code,
        title: input.title.trim(),
        hostAuthUid: null,
        status: 'lobby',
        finalizedSpotId: null,
        decisionVersion: 1,
        finalizedAt: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      participants: [host, ...friends],
      spots: cloneSpots(),
      currentParticipantId: hostId,
    };
    store[code] = { detail, votes: [] };
    this.saveStore(store);
    const current = this.loadCurrent();
    current[roomId] = hostId;
    this.saveCurrent(current);
    setLastCodeHint(code);
    return structuredClone(detail);
  }

  async joinRoom(input: JoinRoomInput): Promise<RoomDetail> {
    await delay(500);
    const nameError = validateDisplayName(input.displayName);
    if (nameError) throw new RoomServiceError(nameError);
    setDisplayNameDraft(input.displayName);
    const code = normalizeInviteCode(input.inviteCode);
    this.purgeBestEffort();
    const store = this.loadStore();
    seedDemoRoomIfNeeded(store);
    const stored = store[code];
    if (!stored) throw new RoomNotFoundError(code);
    if (isRoomExpired(stored.detail.room)) {
      throw new CoordinationError('EXPIRED', 'This meeting link has expired.');
    }
    // Joining a finalized room is allowed (view-only); voting and
    // finalization stay guarded by the state machine.
    //
    // Identity is the per-browser current-participant map — NEVER the
    // display name. Matching by name let a joiner adopt another
    // participant (including the host) and silently dropped the
    // submitted location. A browser that already joined this room
    // rejoins as the SAME participant, with the submitted display name
    // and location applied; a new browser always creates a new
    // participant, even when the display name matches someone else.
    const current = this.loadCurrent();
    const existingId = current[stored.detail.room.id];
    const existing = existingId
      ? stored.detail.participants.find((p) => p.id === existingId)
      : undefined;
    const now = new Date().toISOString();
    if (existing) {
      existing.displayName = input.displayName.trim();
      existing.lastSeenAt = now;
      existing.location = {
        id: existing.location?.id ?? newId('location'),
        participantId: existing.id,
        roomId: stored.detail.room.id,
        lat: input.location.lat,
        lng: input.location.lng,
        label: input.locationLabel.trim(),
        accuracyM: input.accuracyM ?? 20,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      };
      stored.detail.currentParticipantId = existing.id;
      this.saveStore(store);
      setLastCodeHint(code);
      return structuredClone(stored.detail);
    }
    const pid = newId('participant');
    const participant: Participant = {
      id: pid,
      roomId: stored.detail.room.id,
      authUid: null,
      displayName: input.displayName.trim(),
      avatarColor: AVATAR_COLORS[stored.detail.participants.length % AVATAR_COLORS.length],
      isHost: false,
      isReady: false,
      joinedAt: now,
      lastSeenAt: now,
      arrivedAt: null,
      location: {
        id: newId('location'),
        participantId: pid,
        roomId: stored.detail.room.id,
        lat: input.location.lat,
        lng: input.location.lng,
        label: input.locationLabel.trim(),
        accuracyM: input.accuracyM ?? 20,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
    };
    stored.detail.participants.push(participant);
    stored.detail.currentParticipantId = pid;
    this.saveStore(store);
    current[stored.detail.room.id] = pid;
    this.saveCurrent(current);
    setLastCodeHint(code);
    return structuredClone(stored.detail);
  }

  async getRoomByCode(code: string): Promise<RoomDetail | null> {
    await delay(350);
    const normalized = normalizeInviteCode(code);
    this.purgeBestEffort();
    const store = this.loadStore();
    seedDemoRoomIfNeeded(store);
    // Persist the seed: without this, the demo room gets a fresh id on
    // every call and the current-participant map never matches it.
    this.saveStore(store);
    const stored = store[normalized];
    if (!stored) return null;
    const current = this.loadCurrent();
    const detail = structuredClone(stored.detail);
    detail.currentParticipantId = current[detail.room.id] ?? detail.currentParticipantId;
    return detail;
  }

  async getRoomDetail(roomId: string): Promise<RoomDetail | null> {
    await delay(250);
    this.purgeBestEffort();
    const store = this.loadStore();
    const found = Object.values(store).find((s) => s.detail.room.id === roomId);
    if (!found) return null;
    const current = this.loadCurrent();
    const detail = structuredClone(found.detail);
    detail.currentParticipantId = current[roomId] ?? detail.currentParticipantId;
    return detail;
  }

  async updateLocation(input: UpdateLocationInput): Promise<void> {
    await delay(300);
    const store = this.loadStore();
    const stored = Object.values(store).find((s) => s.detail.room.id === input.roomId);
    if (!stored) throw new RoomServiceError('Room not found.');
    if (isRoomExpired(stored.detail.room)) {
      throw new CoordinationError('EXPIRED', 'This meeting has expired.');
    }
    const current = this.loadCurrent();
    const pid = current[input.roomId];
    const participant = stored.detail.participants.find((p) => p.id === pid);
    if (!participant) throw new RoomServiceError('Join the room before updating your location.');
    const now = new Date().toISOString();
    participant.location = {
      id: participant.location?.id ?? newId('location'),
      participantId: participant.id,
      roomId: input.roomId,
      lat: input.lat,
      lng: input.lng,
      label: input.label.trim(),
      accuracyM: input.accuracyM ?? 20,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    };
    participant.lastSeenAt = now;
    this.saveStore(store);
  }

  async setReady(roomId: string, participantId: string, ready: boolean): Promise<void> {
    await delay(200);
    const store = this.loadStore();
    const stored = Object.values(store).find((s) => s.detail.room.id === roomId);
    if (!stored) throw new RoomServiceError('Room not found.');
    const p = stored.detail.participants.find((x) => x.id === participantId);
    if (!p) throw new RoomServiceError('Participant not found.');
    // Caller check (mirrors confirmArrival): only the browser whose
    // identity maps to this participant may toggle their readiness.
    const current = this.loadCurrent();
    if (current[roomId] !== participantId) {
      throw new CoordinationError('NOT_MEMBER', 'You can only change your own readiness.');
    }
    p.isReady = ready;
    p.lastSeenAt = new Date().toISOString();
    this.saveStore(store);
  }

  async confirmArrival(roomId: string, participantId: string, arrived: boolean): Promise<void> {
    await delay(200);
    const store = this.loadStore();
    const stored = Object.values(store).find((s) => s.detail.room.id === roomId);
    if (!stored) throw new RoomServiceError('Room not found.');
    const participant = stored.detail.participants.find((x) => x.id === participantId);
    if (!participant) {
      throw new CoordinationError('NOT_MEMBER', 'You are not a participant in this room.');
    }
    // Demo identity is the current-participant map for this browser:
    // you can only confirm your own arrival.
    const current = this.loadCurrent();
    if (current[roomId] !== participantId) {
      throw new CoordinationError('NOT_MEMBER', 'You can only confirm your own arrival.');
    }
    const check = isActionAllowed(stored.detail.room.status, 'arrive', {
      isMember: true,
      isExpired: isRoomExpired(stored.detail.room),
    });
    if (!check.allowed) {
      throw new CoordinationError(check.code ?? 'UNKNOWN', check.reason ?? 'Arrival cannot be confirmed.');
    }
    const now = new Date().toISOString();
    participant.arrivedAt = arrived ? now : null;
    participant.lastSeenAt = now;
    this.saveStore(store);
  }

  async getSpots(roomId: string): Promise<MeetingSpot[]> {
    const detail = await this.getRoomDetail(roomId);
    return detail?.spots ?? [];
  }

  async getRouteEstimates(roomId: string): Promise<RouteEstimate[]> {
    await delay(500);
    const detail = await this.getRoomDetail(roomId);
    if (!detail) return [];
    return buildAllRouteEstimates(roomId, detail.participants, detail.spots);
  }

  async submitVotes(roomId: string, participantId: string, rankedSpotIds: string[]): Promise<Vote[]> {
    await delay(350);
    const store = this.loadStore();
    const stored = Object.values(store).find((s) => s.detail.room.id === roomId);
    if (!stored) throw new RoomServiceError('Room not found.');
    const participant = stored.detail.participants.find((p) => p.id === participantId);
    if (!participant) {
      throw new CoordinationError('NOT_MEMBER', 'You are not a participant in this room.');
    }
    // Caller check (mirrors confirmArrival): only the browser whose
    // identity maps to this participant may vote as them.
    const current = this.loadCurrent();
    if (current[roomId] !== participantId) {
      throw new CoordinationError('NOT_MEMBER', 'You can only vote as yourself.');
    }
    const check = isActionAllowed(stored.detail.room.status, 'vote', {
      isMember: true,
      isExpired: isRoomExpired(stored.detail.room),
    });
    if (!check.allowed) {
      throw new CoordinationError(check.code ?? 'UNKNOWN', check.reason ?? 'Voting is not allowed.');
    }
    const issues = validateVoteSubmission(
      rankedSpotIds,
      stored.detail.spots.map((s) => s.id),
    );
    if (issues.length > 0) {
      throw new CoordinationError('VOTE_FAILED', issues.join(' '));
    }
    // One active ranking: replace the participant's previous votes.
    stored.votes = stored.votes.filter((v) => v.participantId !== participantId);
    rankedSpotIds.forEach((spotId, i) => {
      stored.votes.push({
        id: newId('vote'),
        roomId,
        participantId,
        spotId,
        rank: i + 1,
      });
    });
    this.saveStore(store);
    return stored.votes.filter((v) => v.participantId === participantId);
  }

  async getVotes(roomId: string): Promise<Vote[]> {
    await delay(200);
    const store = this.loadStore();
    const stored = Object.values(store).find((s) => s.detail.room.id === roomId);
    return stored ? [...stored.votes] : [];
  }

  async finalizeMeeting(roomId: string, spotId: string, expectedDecisionVersion?: number): Promise<RoomDetail> {
    await delay(500);
    const store = this.loadStore();
    const stored = Object.values(store).find((s) => s.detail.room.id === roomId);
    if (!stored) throw new RoomServiceError('Room not found.');
    // Demo identity is the current-participant map for this browser.
    const current = this.loadCurrent();
    const callerId = current[roomId];
    const caller = stored.detail.participants.find((p) => p.id === callerId);
    if (!caller) {
      throw new CoordinationError('NOT_MEMBER', 'Join this room first to finalize it.');
    }
    const check = isActionAllowed(stored.detail.room.status, 'finalize', {
      isHost: caller.isHost,
      isMember: true,
      isExpired: isRoomExpired(stored.detail.room),
    });
    if (!check.allowed) {
      throw new CoordinationError(check.code ?? 'UNKNOWN', check.reason ?? 'Finalization is not allowed.');
    }
    const spot = stored.detail.spots.find((s) => s.id === spotId);
    if (!spot) {
      throw new RoomServiceError('That spot does not belong to this room.');
    }
    const currentVersion = stored.detail.room.decisionVersion;
    if (expectedDecisionVersion !== undefined && expectedDecisionVersion !== currentVersion) {
      throw new CoordinationError(
        'STALE_VERSION',
        'This decision is out of date — reload to see the latest room state.',
      );
    }
    const now = new Date().toISOString();
    stored.detail.room.status = 'finalized';
    stored.detail.room.finalizedSpotId = spotId;
    stored.detail.room.finalizedAt = now;
    stored.detail.room.decisionVersion = currentVersion + 1;
    stored.detail.room.updatedAt = now;
    this.saveStore(store);
    const detail = structuredClone(stored.detail);
    detail.currentParticipantId = current[roomId] ?? detail.currentParticipantId;
    return detail;
  }

  subscribeToRoom(
    _roomId: string,
    _onChange: () => void,
    onStatus?: (status: SubscriptionStatus) => void,
  ): () => void {
    // Demo mode has no live channel; useRoomDetail short-circuits to
    // 'demo' status and never relies on this callback.
    onStatus?.('connected');
    return () => undefined;
  }
}
