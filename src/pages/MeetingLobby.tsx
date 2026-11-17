import { lazy, Suspense, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorBanner, EmptyState } from '../components/ErrorBanner';
import { PageSkeleton, Spinner } from '../components/LoadingSkeleton';
import { ParticipantAvatar } from '../components/ParticipantAvatar';
import { MapFallback } from '../components/map/MapFallback';
import { ExpiredBanner, FinalizedBanner } from '../components/RoomBanners';
import { arrivalLabel, arrivalSummary, isRoomExpired } from '../coordination';
import { realtimeLabel, useRoomDetail } from '../lib/useRoomDetail';
import { joinUrlForCode } from '../lib/utils';
import { useGeolocation } from '../map/useGeolocation';
import { getRoomService, getServiceMode } from '../services';
import type { Coordinates } from '../types';
import { cn } from '../lib/utils';

// Lazy: the MapLibre chunk loads with the map section, not the initial bundle.
const MeetingMap = lazy(() => import('../components/map/MeetingMap').then((m) => ({ default: m.MeetingMap })));

export function MeetingLobby() {
  const { code } = useParams<{ code: string }>();
  const { detail, loading, error, reload, realtimeStatus } = useRoomDetail(code);
  const [copied, setCopied] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pinEditing, setPinEditing] = useState(false);
  const [pinDraft, setPinDraft] = useState<Coordinates | null>(null);
  const [locSaving, setLocSaving] = useState(false);
  const geo = useGeolocation();

  if (loading) return <PageSkeleton title="Meeting lobby" />;
  if (error || !detail) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-2xl font-bold text-white">Meeting lobby</h1>
        <ErrorBanner title="Room not found" message={error ?? 'Room not found.'} onRetry={reload} showJoinLink />
      </div>
    );
  }

  const { room, participants, currentParticipantId } = detail;
  const current = participants.find((p) => p.id === currentParticipantId) ?? null;
  const readyCount = participants.filter((p) => p.isReady).length;
  const joinUrl = joinUrlForCode(room.inviteCode);
  const expired = isRoomExpired(room);
  const arrivals = arrivalSummary(participants);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setActionError('Copy failed — long-press the link below to copy it manually.');
    }
  }

  async function toggleReady() {
    if (!current) {
      setActionError('You are not a participant in this room yet. Join first to mark yourself ready.');
      return;
    }
    setToggling(true);
    setActionError(null);
    try {
      await getRoomService().setReady(room.id, current.id, !current.isReady);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to update readiness.');
    } finally {
      setToggling(false);
    }
  }

  async function useGpsLocation() {
    if (!current) {
      setActionError('Join the room first to update your location.');
      return;
    }
    setLocSaving(true);
    setActionError(null);
    try {
      const result = await geo.requestLocation();
      await getRoomService().updateLocation({
        roomId: room.id,
        lat: result.coords.lat,
        lng: result.coords.lng,
        label: 'Current location (GPS)',
      });
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to update your location.');
    } finally {
      setLocSaving(false);
    }
  }

  function startPinEdit() {
    setPinDraft(
      current?.location
        ? { lat: current.location.lat, lng: current.location.lng }
        : (detail?.spots[0]?.location ?? { lat: 12.9716, lng: 77.6412 }),
    );
    setPinEditing(true);
  }

  async function savePinLocation() {
    if (!current || !pinDraft) return;
    setLocSaving(true);
    setActionError(null);
    try {
      await getRoomService().updateLocation({
        roomId: room.id,
        lat: pinDraft.lat,
        lng: pinDraft.lng,
        label: current.location?.label ?? 'Pinned location',
      });
      setPinEditing(false);
      setPinDraft(null);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to update your location.');
    } finally {
      setLocSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-white sm:text-3xl">{room.title}</h1>
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-semibold',
              realtimeStatus === 'connected'
                ? 'bg-emerald-500/15 text-emerald-200'
                : realtimeStatus === 'error'
                  ? 'bg-rose-500/15 text-rose-200'
                  : 'bg-white/10 text-slate-200',
            )}
          >
            {realtimeLabel(realtimeStatus)}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-300">
          {participants.length} participant{participants.length === 1 ? '' : 's'} · {readyCount} ready · Status: {room.status}
          {room.status === 'finalized' && ` · ${arrivals.arrivedCount} of ${arrivals.totalCount} arrived`}
        </p>
      </div>

      {realtimeStatus === 'error' && (
        <ErrorBanner title="Live updates unavailable" message="The lobby may be out of date. Reload to refresh." onRetry={reload} retryLabel="Reload lobby" />
      )}
      {actionError && <ErrorBanner message={actionError} />}
      <FinalizedBanner room={room} spots={detail.spots} />
      <ExpiredBanner room={room} />

      <section className="glass-card p-5" aria-label="Invite">
        <h2 className="font-semibold text-white">Invite friends</h2>
        <p className="mt-1 text-sm text-slate-300">Share this code or link — it works across browsers and devices.</p>
        <p className="mt-3 font-mono text-2xl font-bold tracking-[0.3em] text-white" aria-label={`Invite code ${room.inviteCode}`}>
          {room.inviteCode}
        </p>
        <p className="mt-2 break-all text-xs text-slate-400">{joinUrl}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={copyLink} className="btn-secondary !px-4 !py-2 text-xs">
            {copied ? 'Copied!' : 'Copy invite link'}
          </button>
          <Link to={`/join/${room.inviteCode}`} className="btn-secondary !px-4 !py-2 text-xs">
            Preview join page
          </Link>
        </div>
      </section>

      <section aria-label="Participants">
        <h2 className="mb-3 font-semibold text-white">Who&apos;s here</h2>
        {participants.length === 0 ? (
          <EmptyState title="No participants yet" description="Share the invite link to bring friends in." />
        ) : (
          <ul className="space-y-2">
            {participants.map((p) => (
              <li key={p.id} className="glass-card flex items-center gap-3 px-4 py-3">
                <ParticipantAvatar name={p.displayName} color={p.avatarColor} isReady={p.isReady} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">
                    {p.displayName}
                    {p.isHost && <span className="ml-2 rounded-full bg-violet-500/20 px-2 py-0.5 text-[11px] text-violet-200">Host</span>}
                    {p.id === currentParticipantId && <span className="ml-2 text-xs text-slate-400">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {p.location ? `${p.location.label} · location expires ${new Date(p.location.expiresAt).toLocaleTimeString()}` : 'No location yet'}
                  </p>
                </div>
                <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-medium', p.isReady ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/10 text-slate-300')}>
                  {p.isReady ? 'Ready' : 'Not ready'}
                </span>
                {room.status === 'finalized' && (
                  <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-medium', p.arrivedAt ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/10 text-slate-300')}>
                    {arrivalLabel(p)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Map">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-white">Map</h2>
          <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-slate-200">
            {realtimeLabel(realtimeStatus)}
          </span>
          {getServiceMode() === 'demo' && (
            <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200">
              Demo data
            </span>
          )}
        </div>
        <Suspense fallback={<MapFallback />}>
          <MeetingMap
            participants={participants}
            spots={detail.spots}
            pinLocation={pinEditing ? pinDraft : null}
            pinDraggable={pinEditing}
            onMapClick={pinEditing ? (coords) => setPinDraft(coords) : undefined}
            onPinChange={pinEditing ? (coords) => setPinDraft(coords) : undefined}
            fitKey={`lobby-${room.id}`}
            ariaLabel="Map of participants and meeting spots"
          />
        </Suspense>
        <p className="mt-2 text-xs text-slate-400">
          {realtimeStatus === 'connected'
            ? 'Markers move live when friends join or update their location.'
            : realtimeStatus === 'demo'
              ? 'Demo mode: markers show demo locations and do not update live.'
              : 'Participant and spot locations are shown on the map.'}{' '}
          Map: MapLibre + © OpenStreetMap contributors.
        </p>
        {current ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {!pinEditing ? (
              <>
                <button
                  type="button"
                  onClick={useGpsLocation}
                  disabled={locSaving || geo.status === 'requesting' || expired}
                  className="btn-secondary !px-4 !py-2 text-xs"
                >
                  {locSaving || geo.status === 'requesting' ? <Spinner label="Updating location" /> : 'Update with my GPS location'}
                </button>
                <button type="button" onClick={startPinEdit} disabled={locSaving || expired} className="btn-secondary !px-4 !py-2 text-xs">
                  Move my pin on the map
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={savePinLocation} disabled={locSaving || !pinDraft} className="btn-primary !px-4 !py-2 text-xs">
                  {locSaving ? <Spinner label="Saving" /> : 'Save pinned location'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPinEditing(false);
                    setPinDraft(null);
                  }}
                  disabled={locSaving}
                  className="btn-secondary !px-4 !py-2 text-xs"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        ) : (
          <p className="mt-3 text-xs text-slate-400">Join the room to update your location on the map.</p>
        )}
        {pinEditing && pinDraft && (
          <p className="mt-2 text-xs text-slate-300">
            Pin: {pinDraft.lat.toFixed(4)}, {pinDraft.lng.toFixed(4)} — drag the pin or tap the map, then save.
          </p>
        )}
      </section>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="button" onClick={toggleReady} className="btn-secondary flex-1" disabled={toggling || !current || expired}>
          {toggling ? <Spinner label="Updating" /> : current?.isReady ? 'Mark as not ready' : 'Mark as ready'}
        </button>
        <Link to={`/room/${room.inviteCode}/routes`} className="btn-primary flex-1">
          Discover routes →
        </Link>
      </div>
      {!current && (
        <p className="text-center text-sm text-amber-200">
          You are viewing this room without joining. <Link to={`/join/${room.inviteCode}`} className="underline">Join as a participant</Link> to vote and set readiness.
        </p>
      )}
    </div>
  );
}
