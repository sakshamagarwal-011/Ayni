import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ErrorBanner, EmptyState } from '../components/ErrorBanner';
import { PageSkeleton, Spinner } from '../components/LoadingSkeleton';
import { ExpiredBanner, FinalizedBanner, RealtimeStatusBanner } from '../components/RoomBanners';
import { SpotCard } from '../components/SpotCard';
import {
  CoordinationError,
  groupWinner,
  hasFreshLocation,
  isRoomExpired,
  latestEtaLabel,
  ownRanking,
  readEngineSpotOrder,
  selectComparedSpots,
  tallyVotes,
  validateRanking,
  voterParticipation,
} from '../coordination';
import { useRoomDetail } from '../lib/useRoomDetail';
import { getRoomService } from '../services';
import type { RouteEstimate, Vote } from '../types';

function sessionStorageSafe(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function SpotComparison() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { detail, loading, error, reload, realtimeStatus } = useRoomDetail(code);
  const [ranking, setRanking] = useState<string[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [votesLoaded, setVotesLoaded] = useState(false);
  const [votesError, setVotesError] = useState<string | null>(null);
  const [estimates, setEstimates] = useState<RouteEstimate[]>([]);
  const [estimatesError, setEstimatesError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingFinalize, setPendingFinalize] = useState<{ id: string; name: string } | null>(null);
  const rankingInitKeyRef = useRef<string | null>(null);

  // Votes refetch whenever the room detail refetches — including on
  // Realtime vote events (useRoomDetail subscribes to votes changes).
  // No polling, no second channel.
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    getRoomService()
      .getVotes(detail.room.id)
      .then((rows) => {
        if (!cancelled) {
          setVotes(rows);
          setVotesError(null);
          setVotesLoaded(true);
        }
      })
      .catch((e) => {
        // A failed load must surface — silently treating it as "no
        // votes" zeroed the tally and overwrote the real ranking.
        if (!cancelled) {
          setVotesError(e instanceof Error ? e.message : 'Failed to load votes.');
          setVotesLoaded(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detail]);

  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    getRoomService()
      .getRouteEstimates(detail.room.id)
      .then((rows) => {
        if (!cancelled) {
          setEstimates(rows);
          setEstimatesError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setEstimatesError(e instanceof Error ? e.message : 'Failed to load travel estimates.');
      });
    return () => {
      cancelled = true;
    };
  }, [detail]);

  const engineOrder = useMemo(
    () =>
      detail
        ? readEngineSpotOrder(sessionStorageSafe(), detail.room.id, detail.room.decisionVersion)
        : undefined,
    [detail],
  );

  const compared = useMemo(
    () => (detail ? selectComparedSpots(detail.spots, votes, engineOrder) : null),
    [detail, votes, engineOrder],
  );
  const comparedIds = useMemo(() => (compared?.compared.map((s) => s.id) ?? []), [compared]);

  // Initialize the ranking once per room + participant: the saved
  // ranking when the participant already voted, else the compared
  // order. Later Realtime vote updates never reset an in-progress edit.
  // Never initialize from a FAILED load: an empty vote set from an
  // error is not "no votes" and must not overwrite the real ranking.
  useEffect(() => {
    if (!detail || !votesLoaded || votesError) return;
    const key = `${detail.room.id}:${detail.currentParticipantId ?? 'none'}`;
    if (rankingInitKeyRef.current === key) return;
    rankingInitKeyRef.current = key;
    const savedRanking =
      detail.currentParticipantId != null ? ownRanking(votes, detail.currentParticipantId, comparedIds) : null;
    setRanking(savedRanking ?? [...comparedIds]);
  }, [detail, votes, votesLoaded, votesError, comparedIds]);

  const tally = useMemo(
    () => tallyVotes(votes, comparedIds),
    [votes, comparedIds],
  );
  const tallyBySpot = useMemo(() => new Map(tally.perSpot.map((t) => [t.spotId, t])), [tally]);
  const winnerId = useMemo(
    () =>
      detail
        ? groupWinner(tally, new Map(detail.spots.map((s) => [s.id, s.name])))
        : null,
    [tally, detail],
  );

  if (loading) return <PageSkeleton title="Spot comparison" />;
  if (error || !detail || !compared) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-2xl font-bold text-white">Spot comparison</h1>
        <ErrorBanner title="Room not found" message={error ?? 'Room not found.'} onRetry={reload} showJoinLink joinCode={code} />
      </div>
    );
  }

  const currentParticipantId = detail.currentParticipantId;
  const currentParticipant = detail.participants.find((p) => p.id === currentParticipantId) ?? null;
  const isHost = currentParticipant?.isHost ?? false;
  const roomId = detail.room.id;
  const inviteCode = detail.room.inviteCode;
  const decisionVersion = detail.room.decisionVersion;
  const participants = detail.participants;
  const expired = isRoomExpired(detail.room);
  const finalized = detail.room.status === 'finalized';
  const votingClosed = finalized || expired;
  const participation = voterParticipation(votes, detail.participants.map((p) => p.id));
  const ownSaved = currentParticipantId ? ownRanking(votes, currentParticipantId, comparedIds) : null;
  const ownTopSpot = ownSaved ? detail.spots.find((s) => s.id === ownSaved[0]) : null;
  const winnerSpot = winnerId ? detail.spots.find((s) => s.id === winnerId) : null;

  // The user's ranking, restricted to the compared set (new spots
  // appended in compared order). The user's own order is preserved
  // even when the group tally reorders the compared set.
  const orderedIds = [
    ...ranking.filter((id) => comparedIds.includes(id)),
    ...comparedIds.filter((id) => !ranking.includes(id)),
  ];
  const orderedSpots = orderedIds
    .map((id) => detail.spots.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  function move(id: string, direction: -1 | 1) {
    setRanking((prev) => {
      const base = [...prev.filter((x) => comparedIds.includes(x)), ...comparedIds.filter((x) => !prev.includes(x))];
      const idx = base.indexOf(id);
      const nextIdx = idx + direction;
      if (idx < 0 || nextIdx < 0 || nextIdx >= base.length) return prev;
      [base[idx], base[nextIdx]] = [base[nextIdx], base[idx]];
      return base;
    });
    setSaved(false);
  }

  async function submitVotes() {
    if (!currentParticipantId) {
      setActionError('Join the room first to vote.');
      return;
    }
    const issues = validateRanking(orderedIds, comparedIds);
    if (issues.length > 0) {
      setActionError(issues.join(' '));
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      const mine = await getRoomService().submitVotes(roomId, currentParticipantId, orderedIds);
      setVotes((prev) => [...prev.filter((v) => v.participantId !== currentParticipantId), ...mine]);
      setSaved(true);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to save your vote.');
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmFinalize() {
    if (!pendingFinalize) return;
    const spotId = pendingFinalize.id;
    setFinalizing(true);
    setActionError(null);
    try {
      await getRoomService().finalizeMeeting(roomId, spotId, decisionVersion);
      navigate(`/room/${inviteCode}/navigate`);
    } catch (e) {
      setPendingFinalize(null);
      if (
        e instanceof CoordinationError &&
        (e.code === 'STALE_VERSION' || e.code === 'ALREADY_FINALIZED')
      ) {
        // The room changed under us: refetch and show the CURRENT
        // decision instead of leaving the user on a stale error.
        setNotice(`${e.message} Showing the latest room state.`);
        reload();
      } else {
        setActionError(e instanceof Error ? e.message : 'Failed to finalize. In live mode only the host can finalize.');
      }
    } finally {
      setFinalizing(false);
    }
  }

  function longestEtaFor(spotId: string): string | null {
    const durations = participants
      .filter((p) => hasFreshLocation(p))
      .map((p) => estimates.find((e) => e.spotId === spotId && e.participantId === p.id && e.mode === 'car'))
      .filter((e): e is RouteEstimate => Boolean(e))
      .map((e) => e.durationMin);
    return latestEtaLabel(durations, new Date());
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white sm:text-3xl">Compare & vote</h1>
        <p className="mt-1 text-sm text-slate-300">
          Rank the spots — #1 is your top choice. Use the up/down buttons to reorder, then save your vote. Spots shown
          are demo data (see the &ldquo;Demo spot&rdquo; tag on each card); see Route Discovery for the map.
        </p>
        <p className="mt-2 text-sm text-slate-300">
          {participation.votedCount} of {participation.totalCount} participants voted.
          {ownTopSpot ? ` Your current #1: ${ownTopSpot.name}.` : ' You have not voted yet.'}
          {compared.capped && ` Showing the top 5 of ${compared.total} spots.`}
        </p>
      </div>

      <FinalizedBanner room={detail.room} spots={detail.spots} />
      <ExpiredBanner room={detail.room} />
      <RealtimeStatusBanner status={realtimeStatus} onRetry={reload} />

      {actionError && <ErrorBanner message={actionError} />}
      {votesError && (
        <ErrorBanner
          title="Votes could not be loaded"
          message={`${votesError} The tally below may be incomplete — retry before voting.`}
          onRetry={reload}
          retryLabel="Retry loading votes"
        />
      )}
      {estimatesError && (
        <ErrorBanner
          title="Travel estimates could not be loaded"
          message={`${estimatesError} Longest-trip times are unavailable.`}
          onRetry={reload}
          retryLabel="Retry loading estimates"
        />
      )}
      {notice && (
        <div role="status" className="glass-card border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
          {notice}
        </div>
      )}
      {saved && (
        <div role="status" className="glass-card border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
          Your ranking was saved. Saving again replaces it — you always have one active vote.
        </div>
      )}
      {finalized && (
        <p role="status" className="text-sm text-slate-300">
          Voting is closed — this meeting is finalized. The destination below is final.
        </p>
      )}

      {pendingFinalize && (
        <div role="alertdialog" aria-label="Confirm finalization" className="glass-card space-y-3 p-4 sm:p-5">
          <p className="font-semibold text-white">Finalize {pendingFinalize.name}?</p>
          <p className="text-sm text-slate-300">
            Everyone will see this destination. Finalizing cannot be undone.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void confirmFinalize()}
              disabled={finalizing}
              className="btn-primary !px-4 !py-2 text-xs"
            >
              {finalizing ? <Spinner label="Finalizing" /> : 'Confirm finalize'}
            </button>
            <button
              type="button"
              onClick={() => setPendingFinalize(null)}
              disabled={finalizing}
              className="btn-secondary !px-4 !py-2 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {orderedSpots.length === 0 ? (
        <EmptyState title="No spots to compare" description="Reload to check for spots again.">
          <button type="button" onClick={reload} className="btn-secondary !px-4 !py-2 text-xs">Reload</button>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {orderedSpots.map((spot, i) => {
            const t = tallyBySpot.get(spot.id);
            const longestEta = longestEtaFor(spot.id);
            return (
              <SpotCard
                key={spot.id}
                spot={spot}
                rank={i + 1}
                votes={t?.firstChoiceCount ?? 0}
                badge={winnerId === spot.id ? 'Group winner' : undefined}
                footer={
                  <div className="space-y-3">
                    <p className="text-xs text-slate-400">
                      Group tally: {t?.firstChoiceCount ?? 0} first-choice · Borda {t?.bordaScore ?? 0}
                      {longestEta ? ` · Longest trip by car — ${longestEta}` : ''}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => move(spot.id, -1)}
                        disabled={i === 0 || votingClosed}
                        className="btn-secondary !px-3 !py-2 text-xs"
                        aria-label={`Move ${spot.name} up`}
                      >
                        ↑ Move up
                      </button>
                      <button
                        type="button"
                        onClick={() => move(spot.id, 1)}
                        disabled={i === orderedSpots.length - 1 || votingClosed}
                        className="btn-secondary !px-3 !py-2 text-xs"
                        aria-label={`Move ${spot.name} down`}
                      >
                        ↓ Move down
                      </button>
                      {isHost && !finalized && !expired && (
                        <button
                          type="button"
                          onClick={() => setPendingFinalize({ id: spot.id, name: spot.name })}
                          disabled={finalizing}
                          className="btn-secondary !px-3 !py-2 text-xs"
                          aria-label={`Finalize ${spot.name} (host)`}
                        >
                          Finalize this spot (host)
                        </button>
                      )}
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
      )}

      {!currentParticipantId && (
        <p className="text-center text-sm text-amber-200">
          You are not a participant yet. <Link to={`/join/${detail.room.inviteCode}`} className="underline">Join this room</Link> to vote.
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link to={`/room/${detail.room.inviteCode}/routes`} className="btn-secondary flex-1">
          ← Back to routes
        </Link>
        <button
          type="button"
          onClick={submitVotes}
          className="btn-secondary flex-1"
          disabled={submitting || !currentParticipantId || votingClosed}
        >
          {submitting ? <Spinner label="Saving vote" /> : 'Save my ranking'}
        </button>
        {finalized ? (
          <Link to={`/room/${detail.room.inviteCode}/navigate`} className="btn-primary flex-1">
            View final destination →
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => winnerSpot && setPendingFinalize({ id: winnerSpot.id, name: winnerSpot.name })}
            className="btn-primary flex-1"
            disabled={finalizing || orderedSpots.length === 0 || !isHost || !winnerSpot || expired}
            title={!isHost ? 'Only the host can finalize' : undefined}
          >
            {finalizing ? (
              <Spinner label="Finalizing" />
            ) : !isHost ? (
              'Finalize (host only)'
            ) : winnerSpot ? (
              `Finalize: ${winnerSpot.name}`
            ) : (
              'Finalize: no votes yet'
            )}
          </button>
        )}
      </div>
      <p className="text-center text-xs text-slate-400">
        {isHost
          ? 'Finalizing picks the group winner by default, or a spot you choose above. Everyone sees the same destination.'
          : 'Only the host can finalize. Finalizing picks the group winner — not any one person’s #1.'}
      </p>
    </div>
  );
}
