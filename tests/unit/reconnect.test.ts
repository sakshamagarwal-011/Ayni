import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelayMs,
  createResilientSubscription,
  MAX_RECONNECT_ATTEMPTS,
  type ChannelHandlers,
  type ChannelStatus,
  type SubscriptionStatus,
} from '../../src/coordination/reconnect';

describe('backoffDelayMs', () => {
  it('backs off 1s, 2s, 4s, then caps at 8s', () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
    expect(backoffDelayMs(3)).toBe(8000);
    expect(backoffDelayMs(4)).toBe(8000);
    expect(backoffDelayMs(99)).toBe(8000);
  });
  it('clamps negative attempts', () => {
    expect(backoffDelayMs(-1)).toBe(1000);
  });
  it('allows at most 5 attempts', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5);
  });
});

/**
 * Manual scheduler: scheduled callbacks run only when the test fires
 * them, so no timers or fake clocks are involved.
 */
function manualScheduler() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const entry = { fn, ms, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    schedule,
    pending,
    runNext() {
      const next = pending.find((p) => !p.cancelled);
      if (!next) return false;
      next.cancelled = true;
      next.fn();
      return true;
    },
    runAll() {
      let ran = 0;
      while (this.runNext()) ran += 1;
      return ran;
    },
  };
}

describe('createResilientSubscription', () => {
  function harness() {
    const handlers: ChannelHandlers[] = [];
    const statuses: SubscriptionStatus[] = [];
    const changes = vi.fn();
    const unsubscribes = vi.fn();
    const scheduler = manualScheduler();
    const sub = createResilientSubscription({
      createChannel: (h) => {
        handlers.push(h);
        return { unsubscribe: unsubscribes };
      },
      onChange: changes,
      onStatus: (s) => statuses.push(s),
      schedule: scheduler.schedule,
    });
    return { handlers, statuses, changes, unsubscribes, scheduler, sub };
  }

  function lastHandler(h: ChannelHandlers[]): ChannelHandlers {
    return h[h.length - 1];
  }

  it('reports connecting then connected on SUBSCRIBED', () => {
    const { handlers, statuses, sub } = harness();
    expect(statuses).toEqual(['connecting']);
    lastHandler(handlers).onStatus('SUBSCRIBED');
    expect(statuses).toEqual(['connecting', 'connected']);
    sub.unsubscribe();
  });

  it('forwards channel events to onChange', () => {
    const { handlers, changes, sub } = harness();
    lastHandler(handlers).onStatus('SUBSCRIBED');
    lastHandler(handlers).onEvent();
    lastHandler(handlers).onEvent();
    expect(changes).toHaveBeenCalledTimes(2);
    sub.unsubscribe();
  });

  it('resubscribes with backoff after CHANNEL_ERROR and reconnects', () => {
    const { handlers, statuses, scheduler, sub } = harness();
    lastHandler(handlers).onStatus('SUBSCRIBED');
    lastHandler(handlers).onStatus('CHANNEL_ERROR');
    expect(statuses).toContain('reconnecting');
    expect(handlers).toHaveLength(1);
    expect(scheduler.pending[0].ms).toBe(1000);
    scheduler.runNext();
    expect(handlers).toHaveLength(2);
    lastHandler(handlers).onStatus('SUBSCRIBED');
    expect(statuses[statuses.length - 1]).toBe('connected');
    sub.unsubscribe();
  });

  it('treats TIMED_OUT and CLOSED the same as CHANNEL_ERROR', () => {
    const { handlers, statuses, scheduler, sub } = harness();
    lastHandler(handlers).onStatus('SUBSCRIBED');
    for (const status of ['TIMED_OUT', 'CLOSED'] as ChannelStatus[]) {
      lastHandler(handlers).onStatus(status);
      scheduler.runNext();
      lastHandler(handlers).onStatus('SUBSCRIBED');
    }
    expect(handlers.length).toBe(3);
    expect(statuses.filter((s) => s === 'reconnecting')).toHaveLength(2);
    sub.unsubscribe();
  });

  it('uses increasing delays across consecutive failures', () => {
    const { handlers, scheduler, sub } = harness();
    lastHandler(handlers).onStatus('SUBSCRIBED');
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      lastHandler(handlers).onStatus('CHANNEL_ERROR');
      delays.push(scheduler.pending[scheduler.pending.length - 1].ms);
      scheduler.runNext();
    }
    expect(delays).toEqual([1000, 2000, 4000]);
    sub.unsubscribe();
  });

  it('gives up after 5 attempts and reports error (no infinite retry)', () => {
    const { handlers, statuses, scheduler, sub } = harness();
    lastHandler(handlers).onStatus('SUBSCRIBED');
    for (let i = 0; i < 5; i += 1) {
      lastHandler(handlers).onStatus('CHANNEL_ERROR');
      scheduler.runNext();
    }
    // The 5th retry's channel fails too -> attempts exhausted -> error.
    lastHandler(handlers).onStatus('CHANNEL_ERROR');
    expect(statuses[statuses.length - 1]).toBe('error');
    expect(handlers).toHaveLength(6); // initial + 5 retries
    expect(scheduler.runAll()).toBe(0); // nothing else scheduled
    sub.unsubscribe();
  });

  it('reconnectNow restarts after failure and resets the attempt count', () => {
    const { handlers, statuses, sub } = harness();
    lastHandler(handlers).onStatus('SUBSCRIBED');
    lastHandler(handlers).onStatus('CHANNEL_ERROR');
    sub.reconnectNow();
    expect(handlers).toHaveLength(2);
    lastHandler(handlers).onStatus('SUBSCRIBED');
    expect(statuses[statuses.length - 1]).toBe('connected');
    sub.unsubscribe();
  });

  it('reconnectNow is a no-op while connected', () => {
    const { handlers, sub } = harness();
    lastHandler(handlers).onStatus('SUBSCRIBED');
    sub.reconnectNow();
    expect(handlers).toHaveLength(1);
    sub.unsubscribe();
  });

  it('unsubscribe tears down the channel and stops retries', () => {
    const { handlers, unsubscribes, scheduler, changes, sub } = harness();
    lastHandler(handlers).onStatus('SUBSCRIBED');
    lastHandler(handlers).onStatus('CHANNEL_ERROR');
    sub.unsubscribe();
    expect(unsubscribes).toHaveBeenCalled();
    expect(scheduler.runAll()).toBe(0);
    lastHandler(handlers).onEvent();
    expect(changes).not.toHaveBeenCalled();
  });

  it('retries when channel creation throws', () => {
    let calls = 0;
    const statuses: SubscriptionStatus[] = [];
    const scheduler = manualScheduler();
    const sub = createResilientSubscription({
      createChannel: () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { unsubscribe: () => undefined };
      },
      onChange: () => undefined,
      onStatus: (s) => statuses.push(s),
      schedule: scheduler.schedule,
    });
    expect(statuses).toContain('reconnecting');
    scheduler.runNext();
    expect(calls).toBe(2);
    sub.unsubscribe();
  });
});
