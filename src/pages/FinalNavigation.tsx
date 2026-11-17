import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorBanner, EmptyState } from '../components/ErrorBanner';
import { PageSkeleton, Spinner } from '../components/LoadingSkeleton';
import { ExpiredBanner, FinalizedBanner, RealtimeStatusBanner } from '../components/RoomBanners';
import { SpotCard } from '../components/SpotCard';
import type { AnimationRouteLine, MapRouteLine } from '../components/map/MeetingMap';
import { MapFallback } from '../components/map/MapFallback';
import { RouteAnimationControls } from '../components/map/RouteAnimationControls';
import { RouteLegend, type LegendRoute } from '../components/map/RouteLegend';
import { useRouteAnimation } from '../components/map/useRouteAnimation';
import { MODE_LABELS, TRAVEL_MODES } from '../lib/distance';
import {
  arrivalLabel,
  arrivalSummary,
  etaLabel,
  hasFreshLocation,
  ownNavigationLinks,
} from '../coordination';
import { useRoomDetail } from '../lib/useRoomDetail';
import { formatDistance, formatDuration, geoUrl, joinUrlForCode, osmDirectionsUrl } from '../lib/utils';
import { describeRouteSource } from '../map/routing';
import { useMapRoutes } from '../map/useMapRoutes';
import { getRoomService, getServiceMode } from '../services';
import type { RouteEstimate, TravelMode } from '../types';

// Lazy: the MapLibre chunk loads with the map section, not the initial bundle.
const MeetingMap = lazy(() => import('../components/map/MeetingMap').then((m) => ({ default: m.MeetingMap })));

export function FinalNavigation() {
  const { code } = useParams<{ code: string }>();
  const { detail, loading, error, reload, realtimeStatus } = useRoomDetail(code);
  const [mode, setMode] = useState<TravelMode>('car');
  const [estimates, setEstimates] = useState<RouteEstimate[]>([]);
  const [copied, setCopied] = useState(false);
  const [arriving, setArriving] = useState(false);
  const [arrivalError, setArrivalError] = useState<string | null>(null);

  useEffect(() => {
    if (!detail) return;
    getRoomService()
      .getRouteEstimates(detail.room.id)
      .then(setEstimates)
      .catch(() => undefined);
  }, [detail]);

  const spot = detail?.spots.find((s) => s.id === detail.room.finalizedSpotId) ?? null;
  const liveRoutes = useMapRoutes(detail?.participants ?? [], spot, mode, detail?.room.id ?? '');
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

  // Progressive animation: geometries come from useMapRoutes (OSRM or
  // labelled demo estimates); playback never calls routing itself.
  const animationRoutes: AnimationRouteLine[] = useMemo(
    () =>
      liveRoutes.routes
        .slice(0, 4)
        .map((r): AnimationRouteLine | null => {
          const participant = detail?.participants.find((p) => p.id === r.participantId);
          if (!participant) return null;
          return {
            participantId: r.participantId,
            color: participant.avatarColor,
            geometry: r.geometry.coordinates,
            durationMin: r.geometry.durationMin,
            distanceM: r.geometry.distanceM,
            label: participant.displayName,
          };
        })
        .filter((l): l is AnimationRouteLine => l !== null),
    [liveRoutes.routes, detail],
  );
  const animation = useRouteAnimation(animationRoutes);
  const animationSig = useMemo(
    () => `${spot?.id ?? 'none'}:${mode}:${animationRoutes.map((r) => r.participantId).join(',')}`,
    [spot, mode, animationRoutes],
  );
  const animationSigRef = useRef(animationSig);
  useEffect(() => {
    if (animationSigRef.current === animationSig) return;
    animationSigRef.current = animationSig;
    animation.resetForRoutes(animationRoutes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationSig]);

  const [immersiveSupport, setImmersiveSupport] = useState({ supported: false, reason: 'Checking whether 3D buildings are available…' });
  const immersiveSupportRef = useRef(immersiveSupport);
  const handleImmersiveSupport = useCallback((supported: boolean, reason: string) => {
    const prev = immersiveSupportRef.current;
    if (prev.supported !== supported || prev.reason !== reason) {
      immersiveSupportRef.current = { supported, reason };
      setImmersiveSupport({ supported, reason });
    }
  }, []);

  if (loading) return <PageSkeleton title="Final navigation" />;
  if (error || !detail) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-2xl font-bold text-white">Final navigation</h1>
        <ErrorBanner title="Room not found" message={error ?? 'Room not found.'} onRetry={reload} showJoinLink />
      </div>
    );
  }

  if (!spot) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-2xl font-bold text-white">Final navigation</h1>
        <ExpiredBanner room={detail.room} />
        <RealtimeStatusBanner status={realtimeStatus} onRetry={reload} />
        <EmptyState
          title="No spot finalized yet"
          description="Head back to Compare & vote to pick a winner, then finalize the meeting."
        >
          <Link to={`/room/${detail.room.inviteCode}/compare`} className="btn-primary !px-4 !py-2 text-xs">
            Go to Compare & vote
          </Link>
        </EmptyState>
      </div>
    );
  }

  const inviteCode = detail.room.inviteCode;
  const roomId = detail.room.id;
  const currentParticipantId = detail.currentParticipantId;
  const currentParticipant = detail.participants.find((p) => p.id === currentParticipantId) ?? null;
  const arrivals = arrivalSummary(detail.participants);
  const now = new Date();

  async function toggleArrival() {
    if (!currentParticipant) return;
    setArriving(true);
    setArrivalError(null);
    try {
      await getRoomService().confirmArrival(roomId, currentParticipant.id, !currentParticipant.arrivedAt);
      reload();
    } catch (e) {
      setArrivalError(e instanceof Error ? e.message : 'Failed to update arrival.');
    } finally {
      setArriving(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(joinUrlForCode(inviteCode));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard unavailable; link is shown as text below.
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-emerald-300">Meeting point locked in</p>
        <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">{detail.room.title}</h1>
        <p className="mt-1 text-sm text-slate-300">Everyone is heading to the same place. See you there.</p>
      </div>

      <SpotCard spot={spot} badge="Final spot" />

      <FinalizedBanner room={detail.room} spots={detail.spots} />
      <ExpiredBanner room={detail.room} />
      <RealtimeStatusBanner status={realtimeStatus} onRetry={reload} />

      <section className="space-y-3" aria-label="Map of routes to the final spot">
        <Suspense fallback={<MapFallback />}>
          <MeetingMap
            participants={detail.participants}
            spots={detail.spots}
            selectedSpotId={spot.id}
            routes={mapLines}
            animationRoutes={animationRoutes}
            animationProgress={animation.progress}
            animationPlaying={animation.playing}
            visibleParticipantIds={animation.visibleIds}
            destinationPulse
            immersive3D={animation.immersive3D}
            onCameraInteraction={animation.pause}
            onImmersiveSupportChange={handleImmersiveSupport}
            fitKey={`navigate-${spot.id}`}
            flyToSpot
            initialPitch={45}
            ariaLabel="Map of routes to the final meeting spot"
          />
        </Suspense>
        {animationRoutes.length > 0 && (
          <RouteAnimationControls
            animation={animation}
            participants={animationRoutes.map((r) => ({
              id: r.participantId,
              name: r.label,
              color: r.color,
            }))}
            immersiveSupported={immersiveSupport.supported}
            immersiveReason={immersiveSupport.reason}
            sourceLabel={describeRouteSource(
              liveRoutes.source,
              liveRoutes.routes.some((r) => r.geometry.transitApproximation),
            )}
          />
        )}
        <RouteLegend
          routes={legendRoutes}
          loading={liveRoutes.status === 'loading'}
          demoMode={getServiceMode() === 'demo'}
          emptyText="No routes to show yet."
        />
      </section>

      <section className="glass-card p-5" aria-label="Travel times">
        <h2 className="font-semibold text-white">Travel times to {spot.name}</h2>
        <div role="tablist" aria-label="Travel mode" className="mt-3 flex flex-wrap gap-2">
          {TRAVEL_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${mode === m ? 'bg-gradient-to-r from-blue-600 to-violet-600 text-white' : 'bg-white/5 text-slate-300'}`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        <ul className="mt-4 space-y-2">
          {detail.participants.map((p) => {
            const est = estimates.find((e) => e.spotId === spot.id && e.participantId === p.id && e.mode === mode);
            const live = liveByParticipant.get(p.id);
            const locationExpired = Boolean(p.location) && !hasFreshLocation(p, now);
            // Expired locations are excluded from ETA/navigation inputs.
            const shown =
              locationExpired || !hasFreshLocation(p, now)
                ? null
                : live
                  ? { distanceM: live.distanceM, durationMin: live.durationMin }
                  : est
                    ? { distanceM: est.distanceM, durationMin: est.durationMin }
                    : null;
            // Navigation links appear ONLY on the current participant's
            // own row, and only from their own fresh location. Other
            // rows show ETA/duration only — no origin coordinates in
            // any href. See coordination/navigation.ts.
            const ownLinks = ownNavigationLinks(
              hasFreshLocation(p, now) && p.location
                ? { lat: p.location.lat, lng: p.location.lng }
                : null,
              spot.location,
              p.id === currentParticipantId,
            );
            return (
              <li key={p.id} className="border-b border-white/5 pb-2 text-sm last:border-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-200">
                    {p.displayName} <span className="text-xs text-slate-400">from {p.location?.label ?? 'unknown'}</span>{' '}
                    <span className="text-xs text-slate-400">· {arrivalLabel(p)}</span>
                  </span>
                  <span className="font-medium text-white">
                    {locationExpired
                      ? 'Location expired — ask them to update'
                      : shown
                        ? `${formatDistance(shown.distanceM)} · ${formatDuration(shown.durationMin)} · ${etaLabel(shown.durationMin, now)}`
                        : 'No location'}
                  </span>
                </div>
                {ownLinks && (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    <a href={ownLinks.osmUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-blue-300 underline">
                      Directions from my location (OpenStreetMap)
                    </a>
                    <a href={ownLinks.geoUri} className="text-xs font-medium text-blue-300 underline">
                      Open with device maps (geo:)
                    </a>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-slate-400">
          {liveRoutes.source === 'osrm'
            ? `${describeRouteSource('osrm', liveRoutes.routes.some((r) => r.geometry.transitApproximation))} — check live conditions before you leave.`
            : liveRoutes.hadFallback
              ? 'Some routes fell back to estimates because OSRM was unavailable. Check live conditions before you leave.'
              : 'Estimates only — check live conditions before you leave.'}
        </p>
      </section>

      {currentParticipant && (
        <section className="glass-card space-y-3 p-5" aria-label="Arrival">
          <h2 className="font-semibold text-white">Arrival</h2>
          <p className="text-sm text-slate-300">
            {arrivals.arrivedCount} of {arrivals.totalCount} arrived.
            {currentParticipant.arrivedAt ? ' You are marked as arrived.' : ' Tap when you arrive — it is optional and reversible.'}
          </p>
          {arrivalError && <ErrorBanner message={arrivalError} />}
          <button
            type="button"
            onClick={toggleArrival}
            disabled={arriving}
            className="btn-secondary !px-4 !py-2 text-xs"
          >
            {arriving ? (
              <Spinner label="Updating arrival" />
            ) : currentParticipant.arrivedAt ? (
              'Not arrived yet — clear my arrival'
            ) : (
              "I've arrived"
            )}
          </button>
        </section>
      )}

      <section className="glass-card space-y-3 p-5" aria-label="Directions and sharing">
        <h2 className="font-semibold text-white">Directions & sharing</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          {/* Spot-only links: no participant origin coordinates here.
              Directions from your own location are on your row above. */}
          <a href={osmDirectionsUrl(null, spot.location)} target="_blank" rel="noreferrer" className="btn-primary flex-1">
            Open spot in OpenStreetMap ↗
          </a>
          <a href={geoUrl(spot.location.lat, spot.location.lng)} className="btn-secondary flex-1">
            Open with device maps (geo:)
          </a>
        </div>
        <p className="text-xs text-slate-400">
          These links open the spot location only — no starting point is shared. Your own row above has directions
          from your location. The geo: link opens your device&apos;s maps app. MeetSync&apos;s maps and routing use
          MapLibre, OpenStreetMap, and OSRM — no paid maps provider and no API keys.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={copyLink} className="btn-secondary flex-1">
            {copied ? 'Link copied!' : 'Copy meeting link'}
          </button>
          <Link to={`/room/${detail.room.inviteCode}/lobby`} className="btn-secondary flex-1">
            Back to lobby
          </Link>
        </div>
        <p className="break-all text-xs text-slate-400">{joinUrlForCode(detail.room.inviteCode)}</p>
      </section>
    </div>
  );
}
