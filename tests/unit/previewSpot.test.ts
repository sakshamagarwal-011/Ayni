import { describe, expect, it } from 'vitest';
import { resolvePreviewTarget } from '../../src/engine/previewSpot';
import type { CandidatePlace } from '../../src/engine/types';
import type { MeetingSpot } from '../../src/types';

function roomSpot(overrides: Partial<MeetingSpot> = {}): MeetingSpot {
  return {
    id: 'spot-blue-bean',
    name: 'The Blue Bean Café',
    category: 'Café',
    address: '100 Ft Road, Indiranagar, Bengaluru',
    location: { lat: 12.9716, lng: 77.6412 },
    rating: 4.6,
    priceLevel: 2,
    openNow: true,
    source: 'default',
    osmId: null,
    publishedRank: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidatePlace> = {}): CandidatePlace {
  return {
    osmId: 'node/902351341',
    name: 'Sahibabad Junction',
    category: 'Railway station',
    lat: 28.6743,
    lng: 77.3644,
    address: 'Railway Road, Sahibabad, Ghaziabad',
    source: 'photon',
    ...overrides,
  };
}

describe('resolvePreviewTarget', () => {
  it('maps a demo mock-id candidate to its room spot', () => {
    const spot = roomSpot({ id: 'spot-blue-bean', source: 'mock' });
    const target = resolvePreviewTarget(
      candidate({ osmId: 'mock/spot-blue-bean', source: 'mock' }),
      [spot],
    );
    expect(target.kind).toBe('room');
    expect(target.spot).toBe(spot);
  });

  it('maps a live candidate to its published room spot by OSM id', () => {
    const spot = roomSpot({
      id: 'uuid-published',
      name: 'Sahibabad Junction',
      source: 'live',
      osmId: 'node/902351341',
      publishedRank: 1,
    });
    const target = resolvePreviewTarget(candidate(), [roomSpot(), spot]);
    expect(target.kind).toBe('room');
    expect(target.spot).toBe(spot);
  });

  it('does not match a live candidate by room-spot id — only by OSM id', () => {
    // A room spot whose id happens to equal the candidate's OSM id but
    // whose osmId differs is NOT the same place.
    const spot = roomSpot({ id: 'node/902351341', osmId: 'node/999' });
    const target = resolvePreviewTarget(candidate(), [spot]);
    expect(target.kind).toBe('preview');
  });

  it('synthesizes a transient preview spot for an unknown live place', () => {
    const target = resolvePreviewTarget(candidate(), [roomSpot()]);
    expect(target.kind).toBe('preview');
    expect(target.spot.id).toBe('preview/node/902351341');
    expect(target.spot.name).toBe('Sahibabad Junction');
    expect(target.spot.category).toBe('Railway station');
    expect(target.spot.address).toBe('Railway Road, Sahibabad, Ghaziabad');
    expect(target.spot.location).toEqual({ lat: 28.6743, lng: 77.3644 });
    expect(target.spot.source).toBe('live');
    expect(target.spot.osmId).toBe('node/902351341');
    expect(target.spot.publishedRank).toBeNull();
    // Placeholders that are never rendered for live spots.
    expect(target.spot.rating).toBe(0);
    expect(target.spot.priceLevel).toBe(1);
    expect(target.spot.openNow).toBe(false);
  });

  it('defaults a missing address to an empty string on the preview spot', () => {
    const noAddress = candidate();
    delete noAddress.address;
    const target = resolvePreviewTarget(noAddress, []);
    expect(target.kind).toBe('preview');
    expect(target.spot.address).toBe('');
  });

  it('falls back to a preview spot for an unknown mock id — never crashes', () => {
    const target = resolvePreviewTarget(
      candidate({ osmId: 'mock/no-such-spot', source: 'mock' }),
      [roomSpot()],
    );
    expect(target.kind).toBe('preview');
    expect(target.spot.id).toBe('preview/mock/no-such-spot');
  });

  it('never mutates its inputs', () => {
    const input = candidate();
    const spot = roomSpot({ source: 'live', osmId: 'node/902351341' });
    const spots = [spot];
    const candidateSnapshot = JSON.stringify(input);
    const spotsSnapshot = JSON.stringify(spots);
    Object.freeze(input);
    Object.freeze(spot);
    Object.freeze(spot.location);
    Object.freeze(spots);
    // Room-kind path (frozen inputs must not throw on a match).
    expect(resolvePreviewTarget(input, spots).kind).toBe('room');
    // Preview-kind path (frozen inputs, no match).
    expect(resolvePreviewTarget(candidate({ osmId: 'node/1' }), spots).kind).toBe('preview');
    expect(JSON.stringify(input)).toBe(candidateSnapshot);
    expect(JSON.stringify(spots)).toBe(spotsSnapshot);
  });
});
