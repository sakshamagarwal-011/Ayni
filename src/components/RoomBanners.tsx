import { Link } from 'react-router-dom';
import { isRoomExpired, timeUntilExpiry } from '../coordination';
import { realtimeLabel } from '../lib/useRoomDetail';
import type { MeetingRoom, MeetingSpot, RealtimeStatus } from '../types';
import { ErrorBanner } from './ErrorBanner';

/**
 * Final destination announcement. Shown on Lobby, Routes, Compare and
 * Navigate whenever the room is finalized. The destination derives
 * ONLY from room.finalized_spot_id + the spots list (single source of
 * truth) — never from local ranking or optimization state — so every
 * participant sees the same destination.
 */
export function FinalizedBanner({ room, spots }: { room: MeetingRoom; spots: MeetingSpot[] }) {
  if (room.status !== 'finalized') return null;
  const spot = spots.find((s) => s.id === room.finalizedSpotId);
  const when = room.finalizedAt ? new Date(room.finalizedAt).toLocaleString() : null;
  if (!spot) {
    // Finalized but the spot row is missing (deleted data): still name
    // the finalized state instead of showing no banner anywhere.
    return (
      <div role="status" className="glass-card border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
        <p className="font-semibold text-white">
          Meeting point locked in{when ? ` (finalized at ${when})` : ''}, but the spot details are unavailable.
        </p>
        <p className="mt-1 text-emerald-100/90">
          This meeting was finalized by the host. Reload to check for the destination details.
        </p>
      </div>
    );
  }
  return (
    <div role="status" className="glass-card border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
      <p className="font-semibold text-white">
        Meeting point locked in: {spot.name}
        {spot.address ? ` — ${spot.address}` : ''}
      </p>
      <p className="mt-1 text-emerald-100/90">
        Finalized by host{when ? ` at ${when}` : ''}. Everyone sees this destination.
      </p>
      <Link to={`/room/${room.inviteCode}/navigate`} className="mt-2 inline-block font-medium text-white underline">
        View final navigation →
      </Link>
    </div>
  );
}

/**
 * Expired-room state. Shown on every room page when the room has
 * expired: actions are disabled by the pages themselves, and this
 * banner explains why and offers a fresh start.
 */
export function ExpiredBanner({ room }: { room: MeetingRoom }) {
  if (!isRoomExpired(room)) return null;
  return (
    <div role="status" className="glass-card border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
      <p className="font-semibold text-white">This meeting has expired.</p>
      <p className="mt-1 text-amber-100/90">
        Voting, finalizing, and new searches are disabled for expired meetings. {timeUntilExpiry(room).label}.
      </p>
      <Link to="/create" className="mt-2 inline-block font-medium text-white underline">
        Create a new meeting →
      </Link>
    </div>
  );
}

/**
 * Connection status for room pages that do not already surface it.
 * Renders nothing while live or in demo mode; shows a retryable error
 * banner when the live connection has failed, and a quiet status line
 * while connecting/reconnecting/offline.
 */
export function RealtimeStatusBanner({
  status,
  onRetry,
}: {
  status: RealtimeStatus;
  onRetry: () => void;
}) {
  if (status === 'connected' || status === 'demo') return null;
  if (status === 'error') {
    return (
      <ErrorBanner
        title="Live updates unavailable"
        message="This page may be out of date. Reload to refresh."
        onRetry={onRetry}
        retryLabel="Reload"
      />
    );
  }
  return (
    <p role="status" className="text-center text-xs text-slate-400">
      {realtimeLabel(status)}
    </p>
  );
}
