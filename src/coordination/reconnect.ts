/**
 * Resilient Realtime subscription with bounded exponential backoff.
 *
 * The Supabase service builds a channel through the injected
 * `createChannel` factory; this helper owns retry state only, so it can
 * be tested with a mocked channel factory and a manual scheduler
 * (no network, no Supabase client).
 *
 * Behaviour:
 * - First subscribe reports 'connecting'; SUBSCRIBED reports
 *   'connected' and resets the attempt counter.
 * - CHANNEL_ERROR / TIMED_OUT / CLOSED schedules a re-subscribe with
 *   backoff (1s, 2s, 4s, 8s, 8s) and reports 'reconnecting'.
 * - After MAX_RECONNECT_ATTEMPTS failed attempts it reports 'error'
 *   and stops retrying; the UI offers a manual Retry (reload), and
 *   `reconnectNow()` (wired to the browser 'online' event) restarts
 *   immediately. No polling loops, no infinite retry.
 * - While the browser reports offline, retries PAUSE without consuming
 *   the attempt budget: the subscription reports 'offline' and waits
 *   for `reconnectNow()` instead of burning all 5 attempts.
 * - `unsubscribe()` cancels any pending retry and tears down the
 *   channel; no further callbacks fire after disposal.
 * - Rapid database events are NOT debounced here — the caller
 *   (useRoomDetail) coalesces refetches with a 300ms debounce.
 */

export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

export type SubscriptionStatus = 'connected' | 'error' | 'connecting' | 'reconnecting' | 'offline';

export interface ChannelHandle {
  unsubscribe: () => void;
}

export interface ChannelHandlers {
  onEvent: () => void;
  onStatus: (status: ChannelStatus) => void;
}

export type ChannelFactory = (handlers: ChannelHandlers) => ChannelHandle;

/** (fn, ms) => cancel. Defaults to setTimeout/clearTimeout. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

export const MAX_RECONNECT_ATTEMPTS = 5;

const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 8000] as const;

/** Backoff delay for attempt `n` (0-based), capped at 8s. */
export function backoffDelayMs(attempt: number): number {
  return BACKOFF_DELAYS_MS[Math.min(Math.max(0, attempt), BACKOFF_DELAYS_MS.length - 1)];
}

export interface ResilientSubscriptionOptions {
  createChannel: ChannelFactory;
  onChange: () => void;
  onStatus?: (status: SubscriptionStatus) => void;
  maxAttempts?: number;
  schedule?: Scheduler;
  delayForAttempt?: (attempt: number) => number;
  /** Connectivity probe. Defaults to navigator.onLine when available, else always online. */
  isOnline?: () => boolean;
}

export interface ResilientSubscription {
  unsubscribe: () => void;
  /** Restart immediately (e.g. browser came back online). No-op while connected/connecting. */
  reconnectNow: () => void;
}

const defaultSchedule: Scheduler = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createResilientSubscription(options: ResilientSubscriptionOptions): ResilientSubscription {
  const maxAttempts = options.maxAttempts ?? MAX_RECONNECT_ATTEMPTS;
  const schedule = options.schedule ?? defaultSchedule;
  const delayForAttempt = options.delayForAttempt ?? backoffDelayMs;
  const isOnline =
    options.isOnline ??
    (() => {
      try {
        return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
      } catch {
        return true;
      }
    });

  let disposed = false;
  let channel: ChannelHandle | null = null;
  let cancelTimer: (() => void) | null = null;
  let attempts = 0;
  let state: 'connecting' | 'connected' | 'waiting' | 'error' = 'connecting';

  function report(status: SubscriptionStatus): void {
    if (!disposed) options.onStatus?.(status);
  }

  function clearTimer(): void {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
  }

  function teardownChannel(): void {
    if (channel) {
      try {
        channel.unsubscribe();
      } catch {
        // Best-effort teardown.
      }
      channel = null;
    }
  }

  function scheduleRetry(): void {
    if (disposed) return;
    if (!isOnline()) {
      // Offline: pause without consuming the attempt budget. The
      // caller restarts via reconnectNow() on the 'online' event.
      state = 'waiting';
      report('offline');
      return;
    }
    if (attempts >= maxAttempts) {
      state = 'error';
      report('error');
      return;
    }
    const delay = delayForAttempt(attempts);
    attempts += 1;
    state = 'waiting';
    report('reconnecting');
    clearTimer();
    cancelTimer = schedule(() => {
      cancelTimer = null;
      if (disposed) return;
      subscribe();
    }, delay);
  }

  function handleChannelStatus(status: ChannelStatus): void {
    if (disposed) return;
    if (status === 'SUBSCRIBED') {
      attempts = 0;
      state = 'connected';
      report('connected');
      return;
    }
    // TIMED_OUT / CLOSED / CHANNEL_ERROR: drop the dead channel, retry with backoff.
    teardownChannel();
    scheduleRetry();
  }

  function subscribe(): void {
    if (disposed) return;
    teardownChannel();
    clearTimer();
    state = 'connecting';
    report('connecting');
    try {
      channel = options.createChannel({
        onEvent: () => {
          if (!disposed) options.onChange();
        },
        onStatus: handleChannelStatus,
      });
    } catch {
      scheduleRetry();
    }
  }

  subscribe();

  return {
    unsubscribe() {
      disposed = true;
      clearTimer();
      teardownChannel();
    },
    reconnectNow() {
      if (disposed || state === 'connected' || state === 'connecting') return;
      attempts = 0;
      subscribe();
    },
  };
}
