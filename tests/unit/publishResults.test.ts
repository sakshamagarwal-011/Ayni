import { describe, expect, it } from 'vitest';
import { readEngineSpotOrder, saveEngineSpotOrder } from '../../src/coordination/voting';
import { CoordinationError } from '../../src/coordination/errors';
import {
  isLiveSearchResult,
  publishPlacesFromRanked,
  type OptimizationResult,
  type ScoredCandidate,
} from '../../src/engine';
import { hasSpotDetails, isLiveSpot } from '../../src/lib/utils';
import { MockRoomService, createMemoryMockStorage } from '../../src/services/mockService';
import type { PublishPlaceInput } from '../../src/services/types';
import type { MeetingSpot } from '../../src/types';

function spot(source: string): MeetingSpot {
  return {
    id: 'spot-1',
    name: 'Test Spot',
    category: 'Café',
    address: 'Somewhere',
    location: { lat: 12.97, lng: 77.64 },
    rating: 4.5,
    priceLevel: 2,
    openNow: true,
    source,
  };
}

describe('spot provenance labelling', () => {
  it('live spots are identified by source, demo/seeded spots are not', () => {
    expect(isLiveSpot(spot('live'))).toBe(true);
    expect(isLiveSpot(spot('mock'))).toBe(false);
    expect(isLiveSpot(spot('default'))).toBe(false);
    expect(isLiveSpot(spot('manual'))).toBe(false);
  });

  it('rating/price/open-now render only for demo/seeded spots — never for live spots', () => {
    expect(hasSpotDetails(spot('mock'))).toBe(true);
    expect(hasSpotDetails(spot('default'))).toBe(true);
    // Live spots store placeholder rating/price/open-now values that
    // must never reach the UI; unknown sources are treated the same.
    expect(hasSpotDetails(spot('live'))).toBe(false);
    expect(hasSpotDetails(spot('manual'))).toBe(false);
    expect(hasSpotDetails(spot('something-else'))).toBe(false);
  });
});

function rankedCandidate(osmId: string, source: 'overpass' | 'photon' | 'mock'): ScoredCandidate {
  return {
    candidate: {
      osmId,
      name: `Place ${osmId}`,
      category: 'Café',
      lat: 12.97,
      lng: 77.64,
      address: 'Somewhere',
      source,
    },
    perParticipant: [],
    totalMin: 5,
    averageMin: 5,
    maxMin: 5,
    stdDevMin: 0,
    score: 5,
    rank: 1,
    explanation: 'test',
  };
}

function searchResult(ranked: ScoredCandidate[]): OptimizationResult {
  return {
    ranked,
    excluded: [],
    searchAreas: [],
    warnings: [],
    provider: 'osrm',
    generatedAt: '2026-11-17T00:00:00.000Z',
    meetingTimeISO: '2026-11-17T02:00:00.000Z',
    preference: 'balanced',
    category: 'cafe',
    stats: {
      discovered: ranked.length,
      duplicatesRemoved: 0,
      invalidRemoved: 0,
      considered: ranked.length,
      routePairs: 0,
      routeFailures: 0,
    },
    decisionVersion: 1,
    participantsSignature: 'test',
  };
}

describe('publish mapping (pure)', () => {
  it('live results (overpass/photon) are publishable; mock results are not', () => {
    expect(isLiveSearchResult(searchResult([rankedCandidate('node/1', 'overpass')]))).toBe(true);
    expect(isLiveSearchResult(searchResult([rankedCandidate('node/1', 'photon')]))).toBe(true);
    expect(isLiveSearchResult(searchResult([rankedCandidate('mock/abc', 'mock')]))).toBe(false);
    // Mixed: any mock candidate disqualifies the set.
    expect(
      isLiveSearchResult(searchResult([rankedCandidate('node/1', 'photon'), rankedCandidate('mock/abc', 'mock')])),
    ).toBe(false);
    expect(isLiveSearchResult(searchResult([]))).toBe(false);
    expect(isLiveSearchResult(null)).toBe(false);
  });

  it('maps ranked candidates to the publish payload in order, capped at 5, with no invented fields', () => {
    const ranked = [
      'node/1',
      'way/2',
      'relation/3',
      'node/4',
      'node/5',
      'node/6',
      'node/7',
    ].map((id) => rankedCandidate(id, 'photon'));
    const places = publishPlacesFromRanked(ranked);
    expect(places).toHaveLength(5);
    expect(places.map((p) => p.osmId)).toEqual(['node/1', 'way/2', 'relation/3', 'node/4', 'node/5']);
    expect(places[0]).toEqual({
      osmId: 'node/1',
      name: 'Place node/1',
      category: 'Café',
      lat: 12.97,
      lng: 77.64,
      address: 'Somewhere',
    });
    // No rating/price/open-now keys on the payload.
    for (const p of places) {
      expect('rating' in p).toBe(false);
      expect('priceLevel' in p).toBe(false);
      expect('openNow' in p).toBe(false);
    }
  });

  it('omits the address key when the candidate has none', () => {
    const entry = rankedCandidate('node/9', 'photon');
    delete entry.candidate.address;
    const [place] = publishPlacesFromRanked([entry]);
    expect('address' in place).toBe(false);
  });
});

describe('engine order after publish', () => {
  it('saves the RETURNED ids + RETURNED version, readable only at the new version', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    // Simulate the panel's post-publish save: ids + version as
    // returned by publishResults (not the pre-publish detail).
    saveEngineSpotOrder(storage, 'room-1', {
      spotIds: ['spot-live-1', 'spot-live-2'],
      decisionVersion: 4,
      generatedAt: '2026-11-17T00:00:00.000Z',
    });
    expect(readEngineSpotOrder(storage, 'room-1', 4)).toEqual(['spot-live-1', 'spot-live-2']);
    // The pre-publish version must NOT read the new order.
    expect(readEngineSpotOrder(storage, 'room-1', 3)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mock-service publish (contract shared with the Supabase implementation).
// ---------------------------------------------------------------------------

function place(osmId: string, name = `Place ${osmId}`): PublishPlaceInput {
  return { osmId, name, category: 'Café', lat: 12.97, lng: 77.64, address: 'Somewhere' };
}

async function setupRoom() {
  const storage = createMemoryMockStorage();
  const service = new MockRoomService(storage, createMemoryMockStorage());
  const created = await service.createRoom({
    title: 'Publish Test',
    displayName: 'Host Hema',
    location: { lat: 12.9716, lng: 77.6412 },
    locationLabel: 'Indiranagar',
  });
  return { service, storage, roomId: created.room.id, hostId: created.currentParticipantId! };
}

describe('mock-service publishResults', () => {
  it('adds live spots, bumps decisionVersion, and keeps them visible via getSpots', async () => {
    const { service, roomId } = await setupRoom();
    const before = await service.getRoomDetail(roomId);
    const outcome = await service.publishResults(roomId, [place('node/1'), place('way/2')]);
    expect(outcome.spots).toHaveLength(2);
    expect(outcome.decisionVersion).toBe((before?.room.decisionVersion ?? 1) + 1);
    expect(outcome.spots.map((s) => s.source)).toEqual(['live', 'live']);
    expect(outcome.spots.map((s) => s.osmId)).toEqual(['node/1', 'way/2']);
    // Placeholders are stored but must be the documented ones.
    expect(outcome.spots[0].rating).toBe(0);
    expect(outcome.spots[0].openNow).toBe(false);
    const spots = await service.getSpots(roomId);
    expect(spots).toHaveLength(5); // 3 seeded + 2 published
    expect(spots.filter((s) => s.source === 'live')).toHaveLength(2);
  });

  it('dedups by OSM id: re-publishing updates the row and keeps its id', async () => {
    const { service, roomId } = await setupRoom();
    const first = await service.publishResults(roomId, [place('node/1', 'Old Name')]);
    const second = await service.publishResults(roomId, [place('node/1', 'New Name')]);
    expect(second.spots[0].id).toBe(first.spots[0].id);
    expect(second.spots[0].name).toBe('New Name');
    const spots = await service.getSpots(roomId);
    expect(spots).toHaveLength(4); // 3 seeded + 1 published (no duplicate)
  });

  it('published spots are votable: a ranking over them saves', async () => {
    const { service, roomId, hostId } = await setupRoom();
    const outcome = await service.publishResults(roomId, [place('node/1')]);
    const all = await service.getSpots(roomId);
    const rankedIds = [outcome.spots[0].id, ...all.filter((s) => s.id !== outcome.spots[0].id).map((s) => s.id)];
    const votes = await service.submitVotes(roomId, hostId, rankedIds);
    expect(votes.find((v) => v.spotId === outcome.spots[0].id)?.rank).toBe(1);
  });

  it('rejects non-members, finalized rooms, and invalid payloads', async () => {
    const { service, storage, roomId } = await setupRoom();
    // A second browser that never joined.
    const outsider = new MockRoomService(storage, createMemoryMockStorage());
    await expect(outsider.publishResults(roomId, [place('node/1')])).rejects.toBeInstanceOf(CoordinationError);
    await expect(outsider.publishResults(roomId, [place('node/1')])).rejects.toMatchObject({ code: 'NOT_MEMBER' });

    await expect(service.publishResults(roomId, [])).rejects.toThrow('1 to 5');
    await expect(
      service.publishResults(roomId, [place('node/1'), place('node/2'), place('node/3'), place('node/4'), place('node/5'), place('node/6')]),
    ).rejects.toThrow('1 to 5');
    await expect(service.publishResults(roomId, [place('mock/abc')])).rejects.toThrow('valid OSM id');
    await expect(service.publishResults(roomId, [place('node/1'), place('node/1')])).rejects.toThrow('twice');
    await expect(service.publishResults(roomId, [{ ...place('node/1'), lat: 200 }])).rejects.toThrow('valid coordinates');

    // Finalize, then publish must fail as already-finalized.
    const spots = await service.getSpots(roomId);
    await service.finalizeMeeting(roomId, spots[0].id);
    await expect(service.publishResults(roomId, [place('node/9')])).rejects.toMatchObject({
      code: 'ALREADY_FINALIZED',
    });
  });

  it('enforces the 30-spot cap', async () => {
    const { service, roomId } = await setupRoom();
    // 3 seeded + 27 published = 30.
    for (let batch = 0; batch < 5; batch++) {
      await service.publishResults(
        roomId,
        Array.from({ length: 5 }, (_, i) => place(`node/${batch * 5 + i + 1}`)),
      );
    }
    await service.publishResults(roomId, [place('node/26'), place('node/27')]);
    expect((await service.getSpots(roomId)).length).toBe(30);
    await expect(service.publishResults(roomId, [place('node/28')])).rejects.toThrow('maximum of 30 spots');
  }, 15000);
});
