/**
 * ETA helpers. Pure.
 *
 * ETAs are "if leaving now" clock times computed from a travel duration
 * and the current time. No departure-time traffic model is invented:
 * the duration comes from the routing/estimate layer, and the label
 * always says "if leaving now".
 */
import { formatDuration } from '../lib/utils';

/** Clock time reached by adding a travel duration to `now`. */
export function etaClockTime(durationMin: number, now: Date): Date {
  return new Date(now.getTime() + Math.max(0, durationMin) * 60 * 1000);
}

/** Locale clock time, e.g. "18:42" / "6:42 PM" depending on locale. */
export function formatEtaTime(date: Date): string {
  try {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

/** "ETA 18:42 if leaving now (24 min)". */
export function etaLabel(durationMin: number, now: Date): string {
  return `ETA ${formatEtaTime(etaClockTime(durationMin, now))} if leaving now (${formatDuration(durationMin)})`;
}

/** Latest ETA among a set of durations (the longest trip), or null when empty. */
export function latestEtaLabel(durationsMin: number[], now: Date): string | null {
  if (durationsMin.length === 0) return null;
  return etaLabel(Math.max(...durationsMin), now);
}
