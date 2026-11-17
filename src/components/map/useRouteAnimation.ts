import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { animationDurationMs, polylineLengthM } from '../../engine/animation';

/**
 * Route-animation playback state. INDEPENDENT of routing: this hook
 * accepts already-computed geometries (lengths only, for timing) and
 * never calls any routing or places endpoint.
 *
 * - Progress 0..1, driven by requestAnimationFrame, throttled to ~30fps
 *   state updates so the map (which writes directly to MapLibre) is
 *   not the bottleneck; React re-renders stay cheap (one number).
 * - Pauses when the tab is hidden; resumes only via explicit Play.
 * - Reduced motion: starts paused at full progress (static full
 *   routes) with `reducedMotion` true so the UI can explain why.
 * - Visibility defaults to all routes; toggling never recreates the map.
 */

export interface AnimatableRouteInput {
  participantId: string;
  geometry: number[][];
}

export type AnimationSpeed = 1 | 2;

export interface RouteAnimationState {
  progress: number;
  playing: boolean;
  speed: AnimationSpeed;
  visibleIds: ReadonlySet<string>;
  immersive3D: boolean;
  reducedMotion: boolean;
  durationMs: number;
  play: () => void;
  pause: () => void;
  replay: () => void;
  seek: (progress: number) => void;
  setSpeed: (speed: AnimationSpeed) => void;
  toggleVisibility: (participantId: string) => void;
  setImmersive3D: (on: boolean) => void;
  /** Call when the route set changes (spot/mode change): resets visibility + progress. */
  resetForRoutes: (routes: AnimatableRouteInput[]) => void;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function useRouteAnimation(initialRoutes: AnimatableRouteInput[]): RouteAnimationState {
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const [progress, setProgress] = useState(() => (prefersReducedMotion() ? 1 : 0));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<AnimationSpeed>(1);
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(
    () => new Set(initialRoutes.map((r) => r.participantId)),
  );
  const [immersive3D, setImmersive3D] = useState(false);
  const [durationMs, setDurationMs] = useState(3000);

  const progressRef = useRef(progress);
  // Source of truth for playback progress: accumulated on EVERY
  // animation frame. The React state (`progress`) is only a throttled
  // mirror for rendering. Deriving progress from the throttled state
  // (as before) discarded most increments and ran playback ~2-3x slow.
  const progressValueRef = useRef(progress);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const lastStateUpdateRef = useRef(0);

  const recomputeDuration = useCallback((routes: AnimatableRouteInput[]) => {
    const longest = routes.reduce((max, r) => Math.max(max, polylineLengthM(r.geometry)), 0);
    setDurationMs(animationDurationMs(longest, 1));
  }, []);

  const resetForRoutes = useCallback(
    (routes: AnimatableRouteInput[]) => {
      setVisibleIds(new Set(routes.map((r) => r.participantId)));
      const start = reducedMotion ? 1 : 0;
      progressValueRef.current = start;
      progressRef.current = start;
      setProgress(start);
      setPlaying(false);
      recomputeDuration(routes);
    },
    [reducedMotion, recomputeDuration],
  );

  // Keep duration in sync with the initial route set on mount.
  useEffect(() => {
    recomputeDuration(initialRoutes);
    // Only on mount; route-set changes go through resetForRoutes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!playing) return;
    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (document.hidden) {
        lastTickRef.current = now;
        return;
      }
      const last = lastTickRef.current ?? now;
      lastTickRef.current = now;
      const dt = now - last;
      // Accumulate in the ref on every tick; throttle only the React
      // state update so playback duration matches durationMs.
      const scaled = progressValueRef.current + (dt * speedRef.current) / durationRef.current;
      const clamped = Math.min(1, scaled);
      progressValueRef.current = clamped;
      progressRef.current = clamped;
      // Throttle React state updates to ~30fps; the map reads progress
      // from props and writes to MapLibre directly (no per-frame setState storm).
      if (now - lastStateUpdateRef.current >= 33 || clamped >= 1) {
        lastStateUpdateRef.current = now;
        setProgress(clamped);
      }
      if (clamped >= 1) {
        setPlaying(false);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
    };
  }, [playing]);

  // Pause when the tab is hidden (the rAF loop already freezes, but
  // make the paused state explicit so Play is required to resume).
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const play = useCallback(() => {
    if (progressValueRef.current >= 1) {
      progressValueRef.current = 0;
      progressRef.current = 0;
      setProgress(0);
    }
    setPlaying(true);
  }, []);

  const pause = useCallback(() => setPlaying(false), []);

  const replay = useCallback(() => {
    progressValueRef.current = 0;
    progressRef.current = 0;
    setProgress(0);
    setPlaying(true);
  }, []);

  const seek = useCallback((value: number) => {
    // Non-finite input (NaN from a broken slider/event) degrades to the
    // start instead of freezing the rAF loop below 1 forever.
    const safe = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    progressValueRef.current = safe;
    progressRef.current = safe;
    setProgress(safe);
    setPlaying(false);
  }, []);

  const setSpeed = useCallback((value: AnimationSpeed) => setSpeedState(value), []);

  const toggleVisibility = useCallback((participantId: string) => {
    setVisibleIds((prev) => {
      const next = new Set(prev);
      if (next.has(participantId)) next.delete(participantId);
      else next.add(participantId);
      return next;
    });
  }, []);

  return {
    progress,
    playing,
    speed,
    visibleIds,
    immersive3D,
    reducedMotion,
    durationMs,
    play,
    pause,
    replay,
    seek,
    setSpeed,
    toggleVisibility,
    setImmersive3D,
    resetForRoutes,
  };
}
