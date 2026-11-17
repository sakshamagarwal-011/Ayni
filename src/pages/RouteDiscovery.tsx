import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorBanner, EmptyState } from '../components/ErrorBanner';
import { PageSkeleton } from '../components/LoadingSkeleton';
import { OptimizationPanel } from '../components/OptimizationPanel';
import { ExpiredBanner, FinalizedBanner, RealtimeStatusBanner } from '../components/RoomBanners';
import { SpotCard } from '../components/SpotCard';
import type { MapRouteLine } from '../components/map/MeetingMap';
import { MapFallback } from '../components/map/MapFallback';
import { RouteLegend, type LegendRoute } from '../components/map/RouteLegend';
import { hasFreshLocation } from '../coordination';
import { MODE_LABELS, TRAVEL_MODES, spotScore } from '../lib/distance';
import { useRoomDetail } from '../lib/useRoomDetail';
import { formatDistance, formatDuration } from '../lib/utils';
import { describeRouteSource } from '../map/routing';
import { useMapRoutes } from '../map/useMapRoutes';
import { resolvePreviewTarget, type CandidatePlace } from '../engine';
import { getRoomService, getServiceMode } from '../services';
import type { MeetingSpot, RouteEstimate, TravelMode } from '../types';
import { cn } from '../lib/utils';

// Lazy: the MapLibre chunk loads with the map section, not the initial bundle.
const MeetingMap = lazy(() => import('../components/map/MeetingMap').then((m) => ({ default: m.MeetingMap })));

export function RouteDiscovery() {
  const { code } = useParams<{ code: string }>();
  const { detail, loading, error, reload, realtimeStatus } = useRoomDetail(code);
  const [mode, setMode] = useState<TravelMode>('car');
  const [estimates, setEstimates] = useState<RouteEstimate[]>([]);
  const [estimatesLoading, setEstimatesLoading] = useState(false);
  const [estimatesError, setEstimatesError] = useState<string | null>(null);
  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null);
  const [selectionLatched, setSelectionLatched] = useState(false);
  // Transient search-result preview: a synthesized spot for a search
  // result that is not a room spot yet. Local UI state only — never
  // added to room state, voted on, or sent to the server (see
  // src/engine/previewSpot.ts). Null when a room spot is selected.
  const [previewSpot, setPreviewSpot] = useState<MeetingSpot | null>(null);
  // OSM id of the search result currently previewed on the map, so the
  // panel can ring it. Set by search preview, cleared by room-spot
  // selection (card or pin).
  const [previewedOsmId, setPreviewedOsmId] = useState<string | null>(null);

  const rankedSpots = useMemo(
    () =>
      detail
        ? [...detail.spots].sort((a, b) => spotScore(estimates, a.id, mode) - spotScore(estimates, b.id, mode))
        : [],
    [detail, estimates, mode],
  );
  // Latch the selection on first load: the derived `?? rankedSpots[0]`
  // fallback re-ran on every render, silently switching the selected
  // spot on travel-mode changes and estimate loads.
  useEffect(() => {
    if (!selectionLatched && rankedSpots.length > 0 && selectedSpotId === null) {
      setSelectedSpotId(rankedSpots[0].id);
      setSelectionLatched(true);
    }
  }, [rankedSpots, selectedSpotId, selectionLatched]);
  const roomSelectedSpot =
    rankedSpots.find((s) => s.id === selectedSpotId) ?? (selectionLatched ? null : (rankedSpots[0] ?? null));
  // Effective selection: a search preview wins over the latched room
  // selection. The map header, MeetingMap, legend, and route fetching
  // below all follow this one value, so no further changes are needed
  // for the map to follow the search.
  const selectedSpot = previewSpot ?? roomSelectedSpot;
  // If a previewed place becomes a room spot (published from this or
  // another browser), swap the transient preview for the real spot so
  // two pins never stack at the same coordinates. The panel ring stays:
  // previewedOsmId is the same place either way.
  useEffect(() => {
    if (!previewSpot || !detail) return;
    const match = detail.spots.find((s) => s.osmId != null && s.osmId === previewSpot.osmId);
    if (match) {
      setPreviewSpot(null);
      setSelectedSpotId(match.id);
    }
  }, [detail, previewSpot]);
  const liveRoutes = useMapRoutes(detail?.participants ?? [], selectedSpot, mode, detail?.room.id ?? '');
  const liveByParticipant = useMemo(
    () => new globalThis.Map(liveRoutes.routes.map((r) => [r.participantId, r.geometry])),
    [liveRoutes.routes],
  );
  const mapLines: MapRouteLine[] = useMemo(
    () =>
      liveRoutes.routes
        .map((r) => {
          const participant = detail?.participants.find((p) => p.id === r.participantId);
          if (!participant) return null;
          return {
            participantId: r.participantId,
            spotId: r.spotId,
            geometry: r.geometry.coordinates,
            color: participant.avatarColor,
            label: participant.displayName,
          };
        })
        .filter((l): l is MapRouteLine => l !== null),
    [liveRoutes.routes, detail],
  );
  const legendRoutes: LegendRoute[] = useMemo(
    () =>
      liveRoutes.routes
        .map((r): LegendRoute | null => {
          const participant = detail?.participants.find((p) => p.id === r.participantId);
          if (!participant) return null;
          return {
            key: r.participantId,
            label: participant.displayName,
            color: participant.avatarColor,
            distanceM: r.geometry.distanceM,
            durationMin: r.geometry.durationMin,
            source: r.geometry.source,
            transitApproximation: r.geometry.transitApproximation,
          };
        })
        .filter((l): l is LegendRoute => l !== null),
    [liveRoutes.routes, detail],
  );

  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    setEstimatesLoading(true);
    setEstimatesError(null);
    getRoomService()
      .getRouteEstimates(detail.room.id)
      .then((rows) => {
        if (!cancelled) setEstimates(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setEstimatesError(e instanceof Error ? e.message : 'Failed to load route estimates.');
      })
      .finally(() => {
        if (!cancelled) setEstimatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detail]);

  if (loading) return <PageSkeleton title="Route discovery" />;
  if (error || !detail) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-2xl font-bold text-white">Route discovery</h1>
        <ErrorBanner title="Room not found" message={error ?? 'Room not found.'} onRetry={reload} showJoinLink joinCode={code} />
      </div>
    );
  }

  // Captured after the guard above (detail is non-null here): the
  // preview handler below is a nested function, where TS does not
  // carry the narrowing.
  const roomSpots = detail.spots;

  // Map preview follows the search: a result that maps to a room spot
  // selects that spot; any other result previews a transient spot.
  function handlePreviewCandidate(candidate: CandidatePlace) {
    const target = resolvePreviewTarget(candidate, roomSpots);
    setPreviewedOsmId(candidate.osmId);
    if (target.kind === 'room') {
      setPreviewSpot(null);
      setSelectedSpotId(target.spot.id);
    } else {
      setPreviewSpot(target.spot);
    }
  }

  // Tapping a map pin: the preview pin keeps the preview; any other
  // pin clears it and restores the room-spot selection.
  function handleMapSpotSelect(spotId: string) {
    if (previewSpot && spotId === previewSpot.id) return;
    setPreviewSpot(null);
    setPreviewedOsmId(null);
    setSelectedSpotId(spotId);
  }

  // Tapping a room spot card clears the search preview and selects
  // that room spot.
  function handleRoomSpotSelect(spotId: string) {
    setPreviewSpot(null);
    setPreviewedOsmId(null);
    setSelectedSpotId(spotId);
  }

  // Skeleton only until the FIRST estimates arrive: background refetches
  // (every Realtime update) must keep the existing cards on screen
  // instead of blanking them into a skeleton + replayed animations.
  const showEstimatesSkeleton = estimatesLoading && estimates.length === 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white sm:text-3xl">Route discovery</h1>
        <p className="mt-1 text-sm text-slate-300">
          {detail.room.title} · Estimated travel from each friend&apos;s starting point. Card estimates use
          straight-line distance × 1.3 with average mode speeds — no live traffic. The selected spot&apos;s map routes
          use OSRM road routing when enabled, otherwise the same demo estimates.
        </p>
      </div>

      <FinalizedBanner room={detail.room} spots={detail.spots} />
      <ExpiredBanner room={detail.room} />
      <RealtimeStatusBanner status={realtimeStatus} onRetry={reload} />

      <div role="tablist" aria-label="Travel mode" className="flex flex-wrap gap-2">
        {TRAVEL_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              'rounded-full px-4 py-2 text-sm font-medium',
              mode === m ? 'bg-gradient-to-r from-blue-600 to-violet-600 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10',
            )}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {estimatesError && <ErrorBanner message={estimatesError} onRetry={reload} />}

      <OptimizationPanel detail={detail} mode={mode} onPreviewCandidate={handlePreviewCandidate} previewedOsmId={previewedOsmId} />

      <section className="space-y-3" aria-label="Map of participants, spots, and routes">
        <div>
          <h2 className="font-semibold text-white">Map{selectedSpot ? ` — routes to ${selectedSpot.name}` : ''}</h2>
          <p className="mt-1 text-xs text-slate-400">
            Tap a spot card or a map pin to preview its routes. Map: MapLibre + © OpenStreetMap contributors.
          </p>
        </div>
        <Suspense fallback={<MapFallback />}>
          <MeetingMap
            participants={detail.participants}
            spots={previewSpot ? [...detail.spots, previewSpot] : detail.spots}
            selectedSpotId={selectedSpot?.id ?? null}
            routes={mapLines}
            onSpotSelect={handleMapSpotSelect}
            fitKey={`routes-${mode}-${selectedSpot?.id ?? 'none'}`}
            ariaLabel="Map of participants, meeting spots, and routes"
          />
        </Suspense>
        <RouteLegend
          routes={legendRoutes}
          loading={liveRoutes.status === 'loading'}
          demoMode={getServiceMode() === 'demo'}
          emptyText={selectedSpot ? 'No routes for this spot yet.' : 'Select a spot to see its routes.'}
        />
      </section>

      {showEstimatesSkeleton && <PageSkeleton title="Route estimates" />}

      {!estimatesLoading && detail.spots.length === 0 && (
        <EmptyState title="No meeting spots yet" description="Spots are added when the room is created. Reload to check again.">
          <button type="button" onClick={reload} className="btn-secondary !px-4 !py-2 text-xs">Reload</button>
        </EmptyState>
      )}

      {!showEstimatesSkeleton && rankedSpots.length > 0 && (
        <div className="space-y-3">
          {rankedSpots.map((spot, i) => {
            const isSelected = spot.id === selectedSpot?.id;
            const rows = detail.participants.map((p) => {
              const estimate = estimates.find((e) => e.spotId === spot.id && e.participantId === p.id && e.mode === mode);
              const live = isSelected ? liveByParticipant.get(p.id) : undefined;
              // Expired locations show no travel time here either: the
              // estimate builders already exclude them, but a live route
              // from an earlier fresh fetch must not linger on the row.
              const fresh = hasFreshLocation(p);
              return {
                participant: p,
                expired: Boolean(p.location) && !fresh,
                // Selected spot: prefer live (OSRM/demo) route values; other spots keep estimates.
                shown: !fresh
                  ? null
                  : live
                    ? { distanceM: live.distanceM, durationMin: live.durationMin }
                    : estimate
                      ? { distanceM: estimate.distanceM, durationMin: estimate.durationMin }
                      : null,
              };
            });
            const withEstimates = rows.filter((r) => r.shown);
            const maxMin = withEstimates.length ? Math.max(...withEstimates.map((r) => r.shown!.durationMin)) : 0;
            const anyTransitApprox = liveRoutes.routes.some((r) => r.geometry.transitApproximation);
            return (
              <SpotCard
                key={spot.id}
                spot={spot}
                rank={i + 1}
                selected={isSelected}
                onSelect={() => handleRoomSpotSelect(spot.id)}
                badge={i === 0 ? 'Fairest overall' : undefined}
                footer={
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                      By {MODE_LABELS[mode].toLowerCase()}
                      {withEstimates.length > 0 ? ` · longest trip ${formatDuration(maxMin)}` : ''}
                      {isSelected && liveByParticipant.size > 0 ? ` · ${describeRouteSource(liveRoutes.source, anyTransitApprox)}` : ''}
                    </p>
                    <ul className="space-y-1.5">
                      {rows.map(({ participant, shown, expired }) => (
                        <li key={participant.id} className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-slate-200">{participant.displayName}</span>
                          <span className="text-slate-300">
                            {shown
                              ? `${formatDistance(shown.distanceM)} · ${formatDuration(shown.durationMin)}`
                              : expired
                                ? 'Location expired'
                                : 'No location'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                }
              />
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link to={`/room/${detail.room.inviteCode}/lobby`} className="btn-secondary flex-1">
          ← Back to lobby
        </Link>
        <Link to={`/room/${detail.room.inviteCode}/compare`} className="btn-primary flex-1">
          Compare & vote →
        </Link>
      </div>
    </div>
  );
}
