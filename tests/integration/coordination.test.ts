import { describe, expect, it } from 'vitest';
import {
  CoordinationError,
  etaLabel,
  groupWinner,
  isOptimizationStale,
  ownNavigationLinks,
  spotOnlyNavigationLinks,
  tallyVotes,
} from '../../src/coordination';
import { createResilientSubscription, type ChannelHandlers } from '../../src/coordination/reconnect';
import {
  createDemoEngineRoutingAdapter,
  createMockPlacesClient,
  runOptimization,
  type CandidatePlace,
  type ParticipantOrigin,
} from '../../src/engine';
import { MockRoomService, createMemoryMockStorage, type MockStorage } from '../../src/services/mockService';
import type { RoomDetail } from '../../src/types';

/**
 * Coordination integration tests: two MockRoomService instances share
 * one in-memory store, standing in for two browsers. No network, no
 * live Supabase. Delays in the mock service (~200-600ms per call) are
 * real; each test stays well under the 15s timeout.
 */

const STORE_KEY = 'meetsync-demo-rooms-v1';
const CURRENT_KEY = 'meetsync-demo-current-v1';

async function setup() {
  const storage = createMemoryMockStorage();
  const hostService = new MockRoomService(storage);
  const guestService = new MockRoomService(storage);
  const created = await hostService.createRoom({
    title: 'Coordination Test',
    displayName: 'Host Hema',
    location: { lat: 12.9716, lng: 77.6412 },
    locationLabel: 'Indiranagar',
  });
  const roomId = created.room.id;
  const code = created.room.inviteCode;
  const hostId = created.currentParticipantId!;
  const joined = await guestService.joinRoom({
    inviteCode: code,
    displayName: 'Joiner Jay',
    location: { lat: 12.9352, lng: 77.6245 },
    locationLabel: 'Koramangala',
  });
  const guestId = joined.currentParticipantId!;
  return { storage, hostService, guestService, roomId, code, hostId, guestId };
}

/** Act as a given participant: the demo identity is the current-participant map. */
function actAs(storage: MockStorage, roomId: string, participantId: string | null) {
  const map = participantId === null ? {} : { [roomId]: participantId };
  storage.setItem(CURRENT_KEY, JSON.stringify(map));
}

/** Move the room's expiry into the past (slightly — not >7 days, or purge would prune it). */
function expireRoomInStore(storage: MockStorage, code: string) {
  const raw = storage.getItem(STORE_KEY)!;
  const store = JSON.parse(raw) as Record<string, { detail: RoomDetail }>;
  store[code].detail.room.expiresAt = new Date(Date.now() - 60 * 1000).toISOString();
  storage.setItem(STORE_KEY, JSON.stringify(store));
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.unreachable(`expected CoordinationError ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(CoordinationError);
    expect((e as CoordinationError).code).toBe(code);
  }
}

describe('voting', () => {
  it('saving replaces the previous ranking (one active vote, no duplicates)', async () => {
    const { hostService, roomId, hostId, storage } = await setup();
    actAs(storage, roomId, hostId);
    const detail = await hostService.getRoomDetail(roomId);
    const [a, b, c] = detail!.spots.map((s) => s.id);
    await hostService.submitVotes(roomId, hostId, [a, b, c]);
    await hostService.submitVotes(roomId, hostId, [c, b, a]);
    const votes = await hostService.getVotes(roomId);
    const mine = votes.filter((v) => v.participantId === hostId);
    expect(mine).toHaveLength(3);
    expect(mine.sort((x, y) => x.rank - y.rank).map((v) => v.spotId)).toEqual([c, b, a]);
  });

  it('votes are visible to a second reader and the tally/winner follow the group', async () => {
    const { hostService, guestService, roomId, hostId, guestId, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    const [a, b, c] = detail!.spots.map((s) => s.id);
    actAs(storage, roomId, hostId);
    await hostService.submitVotes(roomId, hostId, [a, b, c]);
    actAs(storage, roomId, guestId);
    await guestService.submitVotes(roomId, guestId, [b, a, c]);
    const votesFromGuest = await guestService.getVotes(roomId);
    expect(votesFromGuest).toHaveLength(6);
    const tally = tallyVotes(votesFromGuest, [a, b, c]);
    const names = new Map(detail!.spots.map((s) => [s.id, s.name]));
    // a and b tie on first choices (1 each); Borda: a=3, b=3; average
    // rank: a=1.5, b=1.5; name order decides.
    expect(groupWinner(tally, names)).toBe(
      detail!.spots.find((s) => s.id === a)!.name < detail!.spots.find((s) => s.id === b)!.name ? a : b,
    );
  });

  it('rejects votes from non-members and invalid rankings', async () => {
    const { hostService, roomId, hostId, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    const [a, b] = detail!.spots.map((s) => s.id);
    await expectCode(hostService.submitVotes(roomId, 'not-a-participant', [a, b]), 'NOT_MEMBER');
    actAs(storage, roomId, hostId);
    await expectCode(hostService.submitVotes(roomId, hostId, [a, a]), 'VOTE_FAILED');
    await expectCode(hostService.submitVotes(roomId, hostId, []), 'VOTE_FAILED');
    await expectCode(hostService.submitVotes(roomId, hostId, ['unknown-spot']), 'VOTE_FAILED');
  });
});

describe('finalization', () => {
  it('host finalizes; every reader sees the same destination', async () => {
    const { hostService, guestService, roomId, hostId, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    const spot = detail!.spots[1];
    actAs(storage, roomId, hostId);
    const finalized = await hostService.finalizeMeeting(roomId, spot.id, detail!.room.decisionVersion);
    expect(finalized.room.status).toBe('finalized');
    expect(finalized.room.finalizedSpotId).toBe(spot.id);
    expect(finalized.room.decisionVersion).toBe(detail!.room.decisionVersion + 1);
    expect(finalized.room.finalizedAt).not.toBeNull();
    const readByGuest = await guestService.getRoomDetail(roomId);
    const readAgain = await hostService.getRoomByCode(detail!.room.inviteCode);
    expect(readByGuest!.room.finalizedSpotId).toBe(spot.id);
    expect(readAgain!.room.finalizedSpotId).toBe(spot.id);
    expect(readByGuest!.spots.find((s) => s.id === readByGuest!.room.finalizedSpotId)?.name).toBe(spot.name);
  });

  it('joining a finalized room is allowed for viewing, but voting is closed', async () => {
    const { hostService, guestService, roomId, hostId, code, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    actAs(storage, roomId, hostId);
    await hostService.finalizeMeeting(roomId, detail!.spots[0].id);
    const late = await guestService.joinRoom({
      inviteCode: code,
      displayName: 'Late Lena',
      location: { lat: 12.9, lng: 77.6 },
      locationLabel: 'HSR Layout',
    });
    expect(late.room.status).toBe('finalized');
    expect(late.room.finalizedSpotId).toBe(detail!.spots[0].id);
    const lateId = late.currentParticipantId!;
    await expectCode(
      guestService.submitVotes(roomId, lateId, detail!.spots.map((s) => s.id)),
      'ALREADY_FINALIZED',
    );
  });

  it('rejects non-host and non-member finalization', async () => {
    const { hostService, roomId, guestId, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    actAs(storage, roomId, guestId);
    await expectCode(hostService.finalizeMeeting(roomId, detail!.spots[0].id), 'NOT_HOST');
    actAs(storage, roomId, null);
    await expectCode(hostService.finalizeMeeting(roomId, detail!.spots[0].id), 'NOT_MEMBER');
  });

  it('rejects a stale decision version on an open room', async () => {
    const { hostService, roomId, hostId, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    actAs(storage, roomId, hostId);
    await expectCode(
      hostService.finalizeMeeting(roomId, detail!.spots[0].id, detail!.room.decisionVersion + 5),
      'STALE_VERSION',
    );
    const stillOpen = await hostService.getRoomDetail(roomId);
    expect(stillOpen!.room.status).toBe('lobby');
    expect(stillOpen!.room.finalizedSpotId).toBeNull();
  });

  it('rejects a second finalize and keeps the first destination', async () => {
    const { hostService, roomId, hostId, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    const [first, second] = detail!.spots;
    actAs(storage, roomId, hostId);
    await hostService.finalizeMeeting(roomId, first.id, detail!.room.decisionVersion);
    await expectCode(
      hostService.finalizeMeeting(roomId, second.id, detail!.room.decisionVersion),
      'ALREADY_FINALIZED',
    );
    const after = await hostService.getRoomDetail(roomId);
    expect(after!.room.finalizedSpotId).toBe(first.id);
  });
});

describe('navigation privacy + ETA', () => {
  it('own row links contain own coords; other rows get no links; shared links are spot-only', async () => {
    const { hostService, roomId, hostId, guestId } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    const spot = detail!.spots[0];
    const host = detail!.participants.find((p) => p.id === hostId)!;
    const guest = detail!.participants.find((p) => p.id === guestId)!;
    const ownLinks = ownNavigationLinks(
      host.location ? { lat: host.location.lat, lng: host.location.lng } : null,
      spot.location,
      true, // own row
    );
    expect(ownLinks!.osmUrl).toContain('12.9716');
    expect(ownLinks!.osmUrl).toContain('77.6412');
    // Another participant's row: no links at all.
    expect(ownNavigationLinks(
      guest.location ? { lat: guest.location.lat, lng: guest.location.lng } : null,
      spot.location,
      false, // another participant's row
    )).toBeNull();
    // Shared section: spot-only, no origin coordinates.
    const shared = spotOnlyNavigationLinks(spot.location);
    expect(shared.osmUrl).not.toContain('12.9716');
    expect(shared.osmUrl).not.toContain('12.9352');
    expect(shared.osmUrl).toContain(`${spot.location.lat}`);
    expect(shared.geoUri).not.toContain('12.9716');
  });

  it('ETA labels are "if leaving now" and derive from estimate durations', async () => {
    const { hostService, roomId } = await setup();
    const estimates = await hostService.getRouteEstimates(roomId);
    const car = estimates.find((e) => e.mode === 'car');
    expect(car).toBeDefined();
    const label = etaLabel(car!.durationMin, new Date(2026, 10, 17, 18, 0, 0));
    expect(label).toContain('if leaving now');
  });
});

describe('arrival', () => {
  it('own arrival sets and clears, flows to the second reader, and others cannot set yours', async () => {
    const { hostService, guestService, roomId, hostId, guestId, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    actAs(storage, roomId, hostId);
    await hostService.finalizeMeeting(roomId, detail!.spots[0].id);
    // Guest confirms their own arrival.
    actAs(storage, roomId, guestId);
    await guestService.confirmArrival(roomId, guestId, true);
    const seenByHost = await hostService.getRoomDetail(roomId);
    expect(seenByHost!.participants.find((p) => p.id === guestId)!.arrivedAt).not.toBeNull();
    // Guest cannot confirm the host's arrival.
    await expectCode(guestService.confirmArrival(roomId, hostId, true), 'NOT_MEMBER');
    // Reversible: clear it again.
    await guestService.confirmArrival(roomId, guestId, false);
    const cleared = await hostService.getRoomDetail(roomId);
    expect(cleared!.participants.find((p) => p.id === guestId)!.arrivedAt).toBeNull();
  });

  it('arrival is rejected before finalization', async () => {
    const { hostService, roomId, hostId, storage } = await setup();
    actAs(storage, roomId, hostId);
    try {
      await hostService.confirmArrival(roomId, hostId, true);
      expect.unreachable('expected arrival to be rejected before finalization');
    } catch (e) {
      expect(e).toBeInstanceOf(CoordinationError);
      expect((e as CoordinationError).message).toMatch(/finalized/);
    }
  });
});

describe('expiry', () => {
  it('an expired room blocks join, vote, finalize, and location updates', async () => {
    const { hostService, guestService, roomId, hostId, guestId, code, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    expireRoomInStore(storage, code);
    await expectCode(
      guestService.joinRoom({
        inviteCode: code,
        displayName: 'Too Late Tom',
        location: { lat: 12.9, lng: 77.6 },
        locationLabel: 'Elsewhere',
      }),
      'EXPIRED',
    );
    actAs(storage, roomId, hostId);
    await expectCode(
      hostService.submitVotes(roomId, hostId, detail!.spots.map((s) => s.id)),
      'EXPIRED',
    );
    await expectCode(
      guestService.submitVotes(roomId, guestId, detail!.spots.map((s) => s.id)),
      'EXPIRED',
    );
    await expectCode(hostService.finalizeMeeting(roomId, detail!.spots[0].id), 'EXPIRED');
    await expectCode(
      hostService.updateLocation({ roomId, lat: 12.9, lng: 77.6, label: 'New' }),
      'EXPIRED',
    );
    // A read marks the room expired in the store (purge pass).
    const after = await guestService.getRoomDetail(roomId);
    expect(after!.room.status).toBe('expired');
  });
});

describe('stale optimization', () => {
  async function runSearch(detail: RoomDetail, decisionVersion: number) {
    const demoPlaces: CandidatePlace[] = detail.spots.map((s) => ({
      osmId: `mock/${s.id}`,
      name: s.name,
      category: s.category,
      lat: s.location.lat,
      lng: s.location.lng,
      address: s.address,
      source: 'mock',
    }));
    const origins: ParticipantOrigin[] = detail.participants
      .filter((p) => p.location)
      .map((p) => ({
        participantId: p.id,
        displayName: p.displayName,
        lat: p.location!.lat,
        lng: p.location!.lng,
        mode: 'car' as const,
        required: true,
        locationUpdatedAt: p.location!.updatedAt,
        locationExpiresAt: p.location!.expiresAt,
        consentGiven: true,
      }));
    return runOptimization(
      {
        roomId: detail.room.id,
        roomStatus: detail.room.status,
        decisionVersion,
        currentParticipantId: detail.currentParticipantId ?? origins[0].participantId,
        memberParticipantIds: detail.participants.map((p) => p.id),
        requiredParticipantIds: detail.participants.map((p) => p.id),
        origins,
        category: 'cafe',
        meetingTimeISO: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        preference: 'balanced',
      },
      {
        placesClient: createMockPlacesClient(demoPlaces),
        routingClient: createDemoEngineRoutingAdapter(),
      },
    );
  }

  it('a result becomes stale after finalization and cannot overwrite the decision', async () => {
    const { hostService, roomId, hostId, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    const result = await runSearch(detail!, detail!.room.decisionVersion);
    expect(isOptimizationStale(result, detail!.room, detail!.participants).stale).toBe(false);
    actAs(storage, roomId, hostId);
    await hostService.finalizeMeeting(roomId, detail!.spots[0].id, detail!.room.decisionVersion);
    const after = await hostService.getRoomDetail(roomId);
    expect(isOptimizationStale(result, after!.room, after!.participants).stale).toBe(true);
    // A finalize attempt carrying the old version is rejected; destination unchanged.
    await expectCode(
      hostService.finalizeMeeting(roomId, detail!.spots[1].id, detail!.room.decisionVersion),
      'ALREADY_FINALIZED',
    );
    const final = await hostService.getRoomDetail(roomId);
    expect(final!.room.finalizedSpotId).toBe(detail!.spots[0].id);
  });

  it('a result becomes stale after a location update', async () => {
    const { hostService, roomId, hostId, storage } = await setup();
    const detail = await hostService.getRoomDetail(roomId);
    const result = await runSearch(detail!, detail!.room.decisionVersion);
    actAs(storage, roomId, hostId);
    await hostService.updateLocation({ roomId, lat: 12.98, lng: 77.65, label: 'Moved' });
    const after = await hostService.getRoomDetail(roomId);
    expect(isOptimizationStale(result, after!.room, after!.participants).stale).toBe(true);
  });
});

describe('reconnect (mocked channel)', () => {
  it('resubscribes after a channel error and refetches on the next event', async () => {
    const { hostService, roomId } = await setup();
    const handlers: ChannelHandlers[] = [];
    const timers: Array<() => void> = [];
    let refetches = 0;
    const sub = createResilientSubscription({
      createChannel: (h) => {
        handlers.push(h);
        return { unsubscribe: () => undefined };
      },
      onChange: () => {
        refetches += 1;
        void hostService.getRoomDetail(roomId);
      },
      schedule: (fn) => {
        timers.push(fn);
        return () => undefined;
      },
    });
    handlers[0].onStatus('SUBSCRIBED');
    handlers[0].onEvent();
    expect(refetches).toBe(1);
    handlers[0].onStatus('CHANNEL_ERROR');
    expect(handlers).toHaveLength(1);
    timers[0]();
    expect(handlers).toHaveLength(2);
    handlers[1].onStatus('SUBSCRIBED');
    handlers[1].onEvent();
    expect(refetches).toBe(2);
    sub.unsubscribe();
  });
});
