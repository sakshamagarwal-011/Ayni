import { useEffect, useMemo, useRef, useState } from 'react';
import { buildRouteEstimate } from '../lib/distance';
import type { MeetingSpot, Participant, RouteSource, TravelMode } from '../types';
import { getMapConfig } from './config';
import { fallbackGeometry, getDefaultRoutingClient, type RouteGeometry } from './routing';

/**
 * Fetches routes for ONE spot + ONE mode (the visible screen's needs
 * only) for every participant with a valid location.
 *
 * Behaviour by routing provider (see src/map/config.ts + MAPS.md):
 * - 'osrm': serial, throttled OSRM requests via the shared client; any
 *   individual failure falls back to a haversine estimate.
 * - 'mock' (default): deterministic demo estimates, no network.
 * - 'off' or routing disabled: no routes at all (markers only).
 *
 * Routing is deliberately NOT a RoomService method: OSRM is a public
 * development routing endpoint, not Supabase data. Location storage and
 * Realtime sync stay in the RoomService layer; this hook only turns
 * already-loaded participant/spot coordinates into drawable lines.
 */

export interface MapRoute {
  participantId: string;
  spotId: string;
  geometry: RouteGeometry;
}

export type MapRoutesStatus = 'idle' | 'loading' | 'ready' | 'fallback';

export interface MapRoutesResult {
  routes: MapRoute[];
  status: MapRoutesStatus;
  /** True when at least one route fell back to an estimate after an OSRM attempt. */
  hadFallback: boolean;
  /** Dominant provenance for section-level labelling. */
  source: RouteSource;
  /** Force a refetch (clears the OSRM cache first). */
  refresh: () => void;
}

const DEBOUNCE_MS = 300;

/** Stable signature so refetches happen only when inputs actually change. */
function signature(participants: Participant[], spot: MeetingSpot | null, mode: TravelMode): string {
  const parts = participants
    .filter((p) => p.location)
    .map((p) => `${p.id}:${p.location!.lat.toFixed(5)},${p.location!.lng.toFixed(5)},${p.location!.expiresAt}`)
    .sort()
    .join('|');
  return `${spot?.id ?? 'none'}:${mode}:${parts}`;
}

export function useMapRoutes(
  participants: Participant[],
  spot: MeetingSpot | null,
  mode: TravelMode,
  roomId = '',
): MapRoutesResult {
  const [routes, setRoutes] = useState<MapRoute[]>([]);
  const [status, setStatus] = useState<MapRoutesStatus>('idle');
  const [hadFallback, setHadFallback] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const sig = useMemo(() => signature(participants, spot, mode), [participants, spot, mode]);
  const sigRef = useRef(sig);
  sigRef.current = sig;

  useEffect(() => {
    const config = getMapConfig();
    const withLocation = participants.filter((p) => p.location);
    if (!spot || withLocation.length === 0 || !config.routingEnabled || config.routingProvider === 'off') {
      setRoutes([]);
      setStatus('idle');
      setHadFallback(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setStatus('loading');

    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (config.routingProvider === 'mock') {
            // Demo estimates, computed locally — no network, instant.
            const demo: MapRoute[] = [];
            for (const p of withLocation) {
              const est = buildRouteEstimate(roomId, p, spot, mode);
              if (!est) continue;
              demo.push({
                participantId: p.id,
                spotId: spot.id,
                geometry: {
                  coordinates: est.geometry ?? [],
                  distanceM: est.distanceM,
                  durationMin: est.durationMin,
                  source: 'mock',
                  profile: 'estimate',
                  transitApproximation: false,
                },
              });
            }
            if (cancelled || sigRef.current !== sig) return;
            setRoutes(demo);
            setHadFallback(false);
            setStatus('ready');
            return;
          }

          // Live OSRM (opt-in): sequential, throttled, cached.
          const geometries = await getDefaultRoutingClient().fetchRoutes(
            withLocation.map((p) => ({
              from: { lat: p.location!.lat, lng: p.location!.lng },
              to: spot.location,
              mode,
            })),
            controller.signal,
          );
          if (cancelled || sigRef.current !== sig) return;
          const mapped: MapRoute[] = withLocation.map((p, i) => ({
            participantId: p.id,
            spotId: spot.id,
            geometry: geometries[i] ?? fallbackGeometry({ lat: p.location!.lat, lng: p.location!.lng }, spot.location, mode),
          }));
          setRoutes(mapped);
          const fellBack = mapped.some((r) => r.geometry.source === 'estimated');
          setHadFallback(fellBack);
          setStatus(fellBack && mapped.every((r) => r.geometry.source === 'estimated') ? 'fallback' : 'ready');
        } catch (err) {
          if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
          // Last-resort: local estimates so the map still shows lines.
          const fallback: MapRoute[] = withLocation
            .map((p) => {
              const est = buildRouteEstimate(roomId, p, spot, mode);
              if (!est) return null;
              return {
                participantId: p.id,
                spotId: spot.id,
                geometry: {
                  coordinates: est.geometry ?? [],
                  distanceM: est.distanceM,
                  durationMin: est.durationMin,
                  source: 'estimated' as RouteSource,
                  profile: 'estimate',
                  transitApproximation: false,
                },
              };
            })
            .filter((r): r is MapRoute => r !== null);
          setRoutes(fallback);
          setHadFallback(true);
          setStatus('fallback');
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
    // participants/spot/mode are captured via `sig`; roomId/refreshKey retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, refreshKey]);

  const source: RouteSource = useMemo(() => {
    if (routes.length === 0) return 'mock';
    if (routes.some((r) => r.geometry.source === 'osrm')) return 'osrm';
    if (routes.some((r) => r.geometry.source === 'estimated')) return 'estimated';
    return 'mock';
  }, [routes]);

  return {
    routes,
    status,
    hadFallback,
    source,
    refresh: () => {
      getDefaultRoutingClient().clearCache();
      setRefreshKey((k) => k + 1);
    },
  };
}
