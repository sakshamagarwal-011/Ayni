import { useCallback, useEffect, useRef, useState } from 'react';
import type { Coordinates } from '../types';

/**
 * Browser Geolocation API hook.
 *
 * Privacy rules:
 * - Location is requested ONLY from an explicit user gesture (a button
 *   click). Never on page load, never polled by default.
 * - No background tracking: watchPosition is available only when a
 *   component explicitly opts in, and is always cleaned up on unmount.
 * - This hook only READS the device position. Sending it anywhere
 *   (Supabase via the existing updateLocation flow) is the caller's
 *   explicit next step, with its own loading/error handling.
 */

export type GeolocationStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unavailable' | 'error';

export interface GeolocationResult {
  coords: Coordinates;
  accuracyM: number | null;
  timestamp: number;
}

export const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 30_000,
};

/** User-facing message for a GeolocationPositionError code. Pure + unit-tested. */
export function geolocationErrorMessage(code: number | null): string {
  switch (code) {
    case 1: // PERMISSION_DENIED
      return 'Location permission was denied. Allow location access in your browser settings, or pick a point on the map / enter coordinates instead.';
    case 2: // POSITION_UNAVAILABLE
      return 'Your device could not determine its location. Check GPS/signal, or pick a point on the map / enter coordinates instead.';
    case 3: // TIMEOUT
      return 'Locating you timed out. Try again, or pick a point on the map / enter coordinates instead.';
    default:
      return 'GPS is unavailable on this device or browser. Pick a point on the map or enter coordinates instead.';
  }
}

export function useGeolocation() {
  const [status, setStatus] = useState<GeolocationStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<GeolocationResult | null>(null);
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const stopWatch = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
  }, []);

  useEffect(() => stopWatch, [stopWatch]);

  const checkPermission = useCallback(async (): Promise<PermissionState | null> => {
    try {
      if (typeof navigator === 'undefined' || !navigator.permissions?.query) return null;
      const result = await navigator.permissions.query({ name: 'geolocation' });
      setPermission(result.state);
      return result.state;
    } catch {
      return null;
    }
  }, []);

  /**
   * Request a one-shot position. Resolves with the result, or rejects
   * with an Error carrying a user-facing message. Also updates status /
   * error / position state for components that render from state.
   */
  const requestLocation = useCallback(async (): Promise<GeolocationResult> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      const message = geolocationErrorMessage(null);
      setStatus('unavailable');
      setError(message);
      throw new Error(message);
    }
    const perm = await checkPermission();
    if (perm === 'denied') {
      const message = geolocationErrorMessage(1);
      setStatus('denied');
      setError(message);
      throw new Error(message);
    }
    setStatus('requesting');
    setError(null);
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const result: GeolocationResult = {
            coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
            accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
            timestamp: pos.timestamp,
          };
          setPosition(result);
          setStatus('granted');
          setPermission('granted');
          resolve(result);
        },
        (err) => {
          const message = geolocationErrorMessage(err.code);
          setStatus(err.code === 1 ? 'denied' : err.code === 2 ? 'unavailable' : 'error');
          setError(message);
          reject(new Error(message));
        },
        GEOLOCATION_OPTIONS,
      );
    });
  }, [checkPermission]);

  /** Opt-in live tracking. Caller must call stopWatch (or unmount) to end it. */
  const startWatch = useCallback(
    (onUpdate: (result: GeolocationResult) => void, onWatchError?: (message: string) => void): void => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        onWatchError?.(geolocationErrorMessage(null));
        return;
      }
      stopWatch();
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const result: GeolocationResult = {
            coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
            accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
            timestamp: pos.timestamp,
          };
          setPosition(result);
          setStatus('granted');
          onUpdate(result);
        },
        (err) => {
          const message = geolocationErrorMessage(err.code);
          setError(message);
          onWatchError?.(message);
        },
        GEOLOCATION_OPTIONS,
      );
    },
    [stopWatch],
  );

  return { status, error, position, permission, requestLocation, startWatch, stopWatch, checkPermission };
}
