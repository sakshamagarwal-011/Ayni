import { useCallback, useEffect, useRef, useState } from 'react';
import { getRoomService } from '../services';
import type { RealtimeStatus, RoomDetail } from '../types';

/**
 * How long to coalesce rapid Realtime events before refetching, so a
 * burst of vote/location changes does not cause a refetch storm.
 */
export const REALTIME_RELOAD_DEBOUNCE_MS = 300;

export function useRoomDetail(code: string | undefined) {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('connecting');
  const [reloadKey, setReloadKey] = useState(0);
  const serviceRef = useRef(getRoomService());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!code) {
      setError('No invite code in the URL.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const found = await serviceRef.current.getRoomByCode(code);
      if (!found) {
        setDetail(null);
        setError(`No meeting room found for invite code "${code}". It may have expired, or you may need to join first.`);
      } else {
        setDetail(found);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the room.');
    } finally {
      setLoading(false);
    }
  }, [code]);

  /**
   * Background refetch for Realtime events / reconnects: updates the
   * room in place without flashing the loading skeleton, and keeps the
   * last good detail when the refetch fails (connection status is
   * reported separately by the subscription).
   */
  const loadQuiet = useCallback(async () => {
    if (!code) return;
    try {
      const found = await serviceRef.current.getRoomByCode(code);
      if (found) {
        setDetail(found);
        setError(null);
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
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void loadQuiet();
      }, REALTIME_RELOAD_DEBOUNCE_MS);
    };
    const unsubscribe = service.subscribeToRoom(detail.room.id, scheduleReload, setRealtimeStatus);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      unsubscribe();
    };
  }, [detail?.room.id, loadQuiet]);

  // Reconnect/visibility: refetch quietly when the browser comes back
  // online or the tab becomes visible again (no polling loops).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const onOnline = () => {
      void loadQuiet();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void loadQuiet();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadQuiet]);

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
