import { useCallback, useEffect, useRef, useState } from 'react';
import { getRoomService } from '../services';
import type { RealtimeStatus, RoomDetail } from '../types';

/**
 * How long to coalesce rapid Realtime events before refetching, so a
 * burst of vote/location changes does not cause a refetch storm.
 */
export const REALTIME_RELOAD_DEBOUNCE_MS = 300;
/** Maximum time a refetch may be delayed by sustained event bursts. */
export const REALTIME_RELOAD_MAX_WAIT_MS = 1000;

export function useRoomDetail(code: string | undefined) {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('connecting');
  const [reloadKey, setReloadKey] = useState(0);
  const [resubscribeKey, setResubscribeKey] = useState(0);
  const serviceRef = useRef(getRoomService());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceFirstRef = useRef<number | null>(null);
  // Monotonic request ids: stale load responses must never overwrite
  // newer ones when loads overlap (no cancellation in the services).
  const requestIdRef = useRef(0);
  const statusRef = useRef(realtimeStatus);
  statusRef.current = realtimeStatus;

  const load = useCallback(async () => {
    if (!code) {
      setError('No invite code in the URL.');
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const found = await serviceRef.current.getRoomByCode(code);
      if (requestId !== requestIdRef.current) return;
      if (!found) {
        setDetail(null);
        setError(`No meeting room found for invite code "${code}". It may have expired, or you may need to join first.`);
      } else {
        setDetail(found);
      }
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load the room.');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [code]);

  /**
   * Background refetch for Realtime events / reconnects: updates the
   * room in place without flashing the loading skeleton, and keeps the
   * last good detail when the refetch fails (connection status is
   * reported separately by the subscription). A definitive not-found
   * (the room disappeared) IS surfaced, so a pruned room does not show
   * stale detail forever.
   */
  const loadQuiet = useCallback(async () => {
    if (!code) return;
    const requestId = ++requestIdRef.current;
    try {
      const found = await serviceRef.current.getRoomByCode(code);
      if (requestId !== requestIdRef.current) return;
      if (found) {
        setDetail(found);
        setError(null);
      } else {
        setDetail(null);
        setError(`No meeting room found for invite code "${code}". It may have expired, or you may need to join first.`);
      }
    } catch {
      // Keep showing the last good detail; the status banner + Retry
      // button cover the failure case.
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Realtime subscription (Supabase) / no-op (demo). Cleaned up on unmount.
  // Events are coalesced with a short debounce; the subscription itself
  // handles reconnect with backoff (see coordination/reconnect.ts).
  useEffect(() => {
    if (!detail?.room.id) return undefined;
    const service = serviceRef.current;
    if (service.mode === 'demo') {
      setRealtimeStatus('demo');
      return undefined;
    }
    const scheduleReload = () => {
      // Trailing debounce with a max wait: under a sustained burst the
      // refetch fires at most 1s after the first event instead of
      // being starved indefinitely by re-arming the timer.
      const nowMs = Date.now();
      if (debounceFirstRef.current === null) debounceFirstRef.current = nowMs;
      if (nowMs - debounceFirstRef.current >= REALTIME_RELOAD_MAX_WAIT_MS) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = null;
        debounceFirstRef.current = null;
        void loadQuiet();
        return;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        debounceFirstRef.current = null;
        void loadQuiet();
      }, REALTIME_RELOAD_DEBOUNCE_MS);
    };
    const unsubscribe = service.subscribeToRoom(detail.room.id, scheduleReload, setRealtimeStatus);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      debounceFirstRef.current = null;
      unsubscribe();
    };
  }, [detail?.room.id, loadQuiet, resubscribeKey]);

  // Reconnect/visibility: refetch quietly when the browser comes back
  // online or the tab becomes visible again (no polling loops). When
  // the live connection previously failed, ALSO resubscribe — a
  // refetch alone never restores a dead channel.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const onOnline = () => {
      if (statusRef.current === 'error') setResubscribeKey((k) => k + 1);
      void loadQuiet();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (statusRef.current === 'error') setResubscribeKey((k) => k + 1);
        void loadQuiet();
      }
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadQuiet]);

  // Expiry trigger: ONE timeout firing at the nearest upcoming expiry
  // (a participant location or the room itself), refetching quietly so
  // expired locations disappear from routes/ETAs without a reload and
  // without polling. Rescheduled whenever the detail changes.
  useEffect(() => {
    if (!detail) return undefined;
    const candidates: number[] = [];
    const roomExpires = new Date(detail.room.expiresAt).getTime();
    if (Number.isFinite(roomExpires)) candidates.push(roomExpires);
    for (const p of detail.participants) {
      if (!p.location) continue;
      const locExpires = new Date(p.location.expiresAt).getTime();
      if (Number.isFinite(locExpires)) candidates.push(locExpires);
    }
    const nowMs = Date.now();
    const upcoming = candidates.filter((t) => t > nowMs).sort((a, b) => a - b)[0];
    if (upcoming === undefined) return undefined;
    const delayMs = Math.min(upcoming - nowMs + 250, 2_147_483_647);
    const timer = setTimeout(() => {
      void loadQuiet();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [detail, loadQuiet]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { detail, loading, error, reload, realtimeStatus };
}

export function realtimeLabel(status: RealtimeStatus): string {
  switch (status) {
    case 'connected':
      return 'Live';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'offline':
      return 'Offline — will reconnect when back online';
    case 'error':
      return 'Live updates unavailable — retry';
    case 'demo':
      return 'Demo — no live updates';
  }
}
