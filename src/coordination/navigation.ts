/**
 * Navigation links — privacy-guarded, open-source only.
 *
 * PRIVACY RULE: a navigation link containing an origin's coordinates is
 * generated ONLY for the current participant's own row, from their own
 * fresh location. Other participants' rows show ETA/duration only —
 * never a link, href, or coordinate text derived from their location.
 * Shared "Directions & sharing" links are spot-only (no origin).
 * Coordinates are never logged and never copied to the clipboard.
 *
 * The original request named a commercial maps provider's navigation
 * links. The user explicitly chose open-source only, so these are
 * OpenStreetMap directions + geo: device links, reusing the existing
 * osmDirectionsUrl/geoUrl pattern. No commercial-maps URL, SDK, or
 * API reference exists anywhere in src/. See COORDINATION.md.
 */
import { geoUrl, osmDirectionsUrl } from '../lib/utils';
import type { Coordinates } from '../types';

export interface NavigationLinks {
  /** OpenStreetMap directions URL (with origin when own location is known, spot-only otherwise). */
  osmUrl: string;
  /** geo: URI for the destination (device maps app). Never contains an origin. */
  geoUri: string;
}

/**
 * Links for one participant row. Returns null unless the row belongs to
 * the current participant AND they have a location — callers must pass
 * `isOwnRow` honestly (participant id === currentParticipantId).
 */
export function ownNavigationLinks(
  ownLocation: Coordinates | null,
  spotLocation: Coordinates,
  isOwnRow: boolean,
): NavigationLinks | null {
  if (!isOwnRow || !ownLocation) return null;
  return {
    osmUrl: osmDirectionsUrl(ownLocation, spotLocation),
    geoUri: geoUrl(spotLocation.lat, spotLocation.lng),
  };
}

/** Spot-only links for shared sections: no origin coordinates anywhere. */
export function spotOnlyNavigationLinks(spotLocation: Coordinates): NavigationLinks {
  return {
    osmUrl: osmDirectionsUrl(null, spotLocation),
    geoUri: geoUrl(spotLocation.lat, spotLocation.lng),
  };
}
