import type { OptimizationResult, ScoredCandidate } from './types';
import type { PublishPlaceInput } from '../services/types';

/**
 * Publish mapping (pure): which engine results may be published as
 * votable spots, and how ranked candidates become publish payloads.
 *
 * Only LIVE results may be published: every ranked candidate must
 * come from a live places source ('overpass' from the direct client
 * or the proxy, 'photon'). Demo results ('mock' candidates, which
 * ARE the room's spots already) are never published — publishing
 * them would duplicate the seeded spots under fake OSM ids.
 *
 * This module is pure (no fetch, no window, no Supabase) so the
 * mapping is unit-testable; the OptimizationPanel calls it and hands
 * the payload to RoomService.publishResults.
 */

/** Maximum places per publish — the ranked top 5, matching the engine's top-N. */
export const MAX_PUBLISH_PLACES = 5;

/** True when a search result is a live, publishable result set. */
export function isLiveSearchResult(result: OptimizationResult | null): boolean {
  if (!result || result.ranked.length === 0) return false;
  return result.ranked.every((entry) => entry.candidate.source !== 'mock');
}

/**
 * Ranked candidates → publish payload, in ranked order, capped at
 * MAX_PUBLISH_PLACES. Carries only what the engine knows (OSM id,
 * name, category label, coordinates, address); rating/price/open-now
 * are never invented. Callers must check isLiveSearchResult first —
 * this function does not re-validate provenance.
 */
export function publishPlacesFromRanked(ranked: ScoredCandidate[]): PublishPlaceInput[] {
  return ranked.slice(0, MAX_PUBLISH_PLACES).map((entry) => ({
    osmId: entry.candidate.osmId,
    name: entry.candidate.name,
    category: entry.candidate.category,
    lat: entry.candidate.lat,
    lng: entry.candidate.lng,
    ...(entry.candidate.address ? { address: entry.candidate.address } : {}),
  }));
}
