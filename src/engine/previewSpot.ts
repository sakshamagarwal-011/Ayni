import type { CandidatePlace } from './types';
import type { MeetingSpot } from '../types';

/**
 * Search-result → map-preview mapping (pure).
 *
 * The Route Discovery map previews ONE spot: the map header, route
 * lines, and legend all follow the page's selected spot. A search
 * result is a CandidatePlace, not a room spot, so previewing it needs
 * a mapping — this module, `resolvePreviewTarget`:
 *
 * - When the candidate IS a room spot already, return that spot
 *   (`kind: 'room'`): demo candidates carry `mock/<spot-id>` (the
 *   same mapping the panel uses for saveEngineSpotOrder), and live
 *   candidates match a published spot by OSM id (re-running a search
 *   after publishing). The page then selects the real room spot.
 * - Otherwise synthesize a TRANSIENT preview spot (`kind:
 *   'preview'`). It carries the candidate's name, category, address,
 *   and coordinates, with placeholder rating/price/open-now values
 *   that are never rendered for `source='live'` rows (see
 *   hasSpotDetails), and an id prefixed `preview/`.
 *
 * A preview spot is local UI state ONLY: it must never be added to
 * room state, voted on, or sent to the server. The `preview/` id
 * prefix must never leave the browser — it exists precisely so a
 * preview id can never collide with a real spot id. Publishing is
 * the only path by which a search result becomes a room spot (see
 * publishPlaces.ts).
 *
 * This module is pure (no fetch, no window, no Supabase) so the
 * mapping is unit-testable.
 */

/** Prefix for demo candidates: `mock/<spot-id>`. */
const MOCK_PREFIX = 'mock/';

/** Prefix for transient preview ids: `preview/<osmId>`. Never persisted, never sent. */
export const PREVIEW_SPOT_ID_PREFIX = 'preview/';

export type PreviewTarget =
  | { kind: 'room'; spot: MeetingSpot }
  | { kind: 'preview'; spot: MeetingSpot };

/**
 * Resolve a search result to the spot the map should preview. Never
 * mutates its inputs: room matches return the existing spot object
 * unchanged, and preview spots are freshly built objects.
 */
export function resolvePreviewTarget(candidate: CandidatePlace, spots: MeetingSpot[]): PreviewTarget {
  if (candidate.source === 'mock' && candidate.osmId.startsWith(MOCK_PREFIX)) {
    const spotId = candidate.osmId.slice(MOCK_PREFIX.length);
    const match = spots.find((s) => s.id === spotId);
    if (match) return { kind: 'room', spot: match };
  } else if (candidate.source !== 'mock') {
    const match = spots.find((s) => s.osmId === candidate.osmId);
    if (match) return { kind: 'room', spot: match };
  }
  // Unknown place (or an unknown mock id): synthesize a transient
  // preview spot. Never throw — a preview failure must not break the
  // search results the user is looking at.
  return {
    kind: 'preview',
    spot: {
      id: `${PREVIEW_SPOT_ID_PREFIX}${candidate.osmId}`,
      name: candidate.name,
      category: candidate.category,
      address: candidate.address ?? '',
      location: { lat: candidate.lat, lng: candidate.lng },
      rating: 0,
      priceLevel: 1,
      openNow: false,
      source: 'live',
      osmId: candidate.osmId,
      publishedRank: null,
    },
  };
}
