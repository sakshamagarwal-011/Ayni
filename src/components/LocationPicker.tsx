import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { STARTING_AREAS } from '../data/mockData';
import type { Coordinates } from '../types';
import { haversineDistanceM } from '../lib/distance';
import { parseCoordinateText, validateLat, validateLng } from '../lib/validation';
import { assessGeolocationFix, useGeolocation } from '../map/useGeolocation';
import { MapFallback } from './map/MapFallback';

// Lazy: the MapLibre chunk loads only when the map tab is opened.
const MeetingMap = lazy(() => import('./map/MeetingMap').then((m) => ({ default: m.MeetingMap })));

export interface LocationValue {
  location: Coordinates;
  label: string;
  /** GPS fix accuracy in metres, when the location came from GPS. */
  accuracyM?: number | null;
}

/** A pin moved further than this leaves its old label behind as stale. */
const LABEL_STALE_MOVE_M = 500;

function coordsEqual(a: Coordinates, b: Coordinates): boolean {
  return a.lat === b.lat && a.lng === b.lng;
}

/**
 * Location picker: preset Bengaluru areas + manual lat/lng + map pin.
 * The map tab adds GPS (Browser Geolocation API, only on button press)
 * and click/drag pin placement on a MapLibre + OpenStreetMap map.
 * Preset/coordinate tabs remain as keyboard-accessible alternatives.
 *
 * No location is selected until the user picks one (`value` starts
 * null): forms require an explicit pick. Coordinate text fields are
 * the source of truth while typing — empty/non-numeric text never
 * emits a value (and never 0,0) — and they re-sync whenever the value
 * changes from outside the text fields (preset, map pin, GPS).
 */
export function LocationPicker({
  value,
  onChange,
  error,
  onValidityChange,
}: {
  value: LocationValue | null;
  onChange: (v: LocationValue) => void;
  error?: string | null;
  /** Reports whether the coordinate text is submittable (custom tab only; other tabs are always valid). */
  onValidityChange?: (valid: boolean) => void;
}) {
  const [mode, setMode] = useState<'preset' | 'custom' | 'map'>('preset');
  const [latText, setLatText] = useState(value ? String(value.location.lat) : '');
  const [lngText, setLngText] = useState(value ? String(value.location.lng) : '');
  const [labelText, setLabelText] = useState(value?.label ?? '');
  const [latDirty, setLatDirty] = useState(false);
  const [lngDirty, setLngDirty] = useState(false);
  const [gpsMessage, setGpsMessage] = useState<string | null>(null);
  const geo = useGeolocation();

  // What this picker last emitted, so the sync effect can tell external
  // value changes apart from the user's own typing.
  const pushedRef = useRef<{ location: Coordinates; label: string } | null>(
    value ? { location: value.location, label: value.label } : null,
  );

  // Sync text fields when the value changes from OUTSIDE the text
  // fields (preset pick, map pin, GPS, parent reset).
  useEffect(() => {
    const pushed = pushedRef.current;
    if (!value) {
      if (pushed !== null) {
        pushedRef.current = null;
        setLatText('');
        setLngText('');
        setLabelText('');
      }
      return;
    }
    if (!pushed || !coordsEqual(pushed.location, value.location) || pushed.label !== value.label) {
      pushedRef.current = { location: value.location, label: value.label };
      setLatText(String(value.location.lat));
      setLngText(String(value.location.lng));
      setLabelText(value.label);
    }
  }, [value]);

  const latNum = parseCoordinateText(latText);
  const lngNum = parseCoordinateText(lngText);
  const latError =
    latDirty && latText.trim() !== ''
      ? (latNum === null ? 'Enter a valid latitude (a number).' : validateLat(latNum))
      : null;
  const lngError =
    lngDirty && lngText.trim() !== ''
      ? (lngNum === null ? 'Enter a valid longitude (a number).' : validateLng(lngNum))
      : null;
  const textValid =
    latNum !== null && lngNum !== null && validateLat(latNum) === null && validateLng(lngNum) === null;

  // Report coordinate-text validity for submit-time validation: the
  // form must not submit stale coordinates while the text is invalid.
  const validityRef = useRef<boolean | null>(null);
  useEffect(() => {
    const valid = mode === 'custom' ? textValid : true;
    if (validityRef.current !== valid) {
      validityRef.current = valid;
      onValidityChange?.(valid);
    }
  }, [mode, textValid, onValidityChange]);

  /** Emit a picked value. `syncTexts` rewrites the text fields (preset/map/GPS); typing keeps its own text. */
  function emit(next: LocationValue, syncTexts: boolean) {
    pushedRef.current = { location: next.location, label: next.label };
    if (syncTexts) {
      setLatText(String(next.location.lat));
      setLngText(String(next.location.lng));
      setLabelText(next.label);
    }
    onChange(next);
  }

  /** Emit from the coordinate text fields — only when BOTH parse and validate. Invalid text emits nothing. */
  function emitFromText(latStr: string, lngStr: string) {
    const lat = parseCoordinateText(latStr);
    const lng = parseCoordinateText(lngStr);
    if (lat === null || lng === null) return;
    if (validateLat(lat) !== null || validateLng(lng) !== null) return;
    emit({ location: { lat, lng }, label: labelText.trim() || 'Custom location', accuracyM: null }, false);
  }

  function handleLabelChange(nextLabel: string) {
    setLabelText(nextLabel);
    if (value) emit({ ...value, label: nextLabel }, false);
  }

  function handlePinCoords(coords: Coordinates) {
    // A significant move invalidates the old label: "Indiranagar" must
    // not follow a pin dragged to Whitefield.
    const moved = value ? haversineDistanceM(value.location, coords) : 0;
    const label =
      moved > LABEL_STALE_MOVE_M ? 'Pinned location' : (value?.label ?? labelText.trim()) || 'Pinned location';
    emit({ location: coords, label, accuracyM: null }, true);
  }

  async function useGps() {
    setGpsMessage(null);
    try {
      const result = await geo.requestLocation();
      emit({ location: result.coords, label: 'Current location (GPS)', accuracyM: result.accuracyM }, true);
      const quality = assessGeolocationFix(result);
      setGpsMessage(
        quality.warning ??
          (result.accuracyM !== null
            ? `GPS location set (accurate to about ${Math.round(result.accuracyM)} m). You can drag the pin to adjust it.`
            : 'GPS location set. You can drag the pin to adjust it.'),
      );
    } catch (e) {
      setGpsMessage(e instanceof Error ? e.message : 'GPS is unavailable — pick on the map or enter coordinates.');
    }
  }

  return (
    <fieldset>
      <legend className="label">Your starting location (required)</legend>
      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Location input mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'preset'}
          onClick={() => setMode('preset')}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${mode === 'preset' ? 'bg-violet-600 text-white' : 'bg-white/5 text-slate-300'}`}
        >
          Choose an area
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'custom'}
          onClick={() => setMode('custom')}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${mode === 'custom' ? 'bg-violet-600 text-white' : 'bg-white/5 text-slate-300'}`}
        >
          Enter coordinates
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'map'}
          onClick={() => setMode('map')}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${mode === 'map' ? 'bg-violet-600 text-white' : 'bg-white/5 text-slate-300'}`}
        >
          Pick on map
        </button>
      </div>

      {mode === 'preset' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {STARTING_AREAS.map((area) => {
            // Highlight by COORDINATES, not label: a hand-typed label
            // matching an area name must not falsely highlight it, and
            // a preset must not stay highlighted after a pin drag.
            const selected =
              value !== null &&
              value.location.lat === area.location.lat &&
              value.location.lng === area.location.lng;
            return (
              <button
                key={area.id}
                type="button"
                aria-pressed={selected}
                onClick={() => emit({ location: area.location, label: area.area, accuracyM: null }, true)}
                className={`rounded-xl border px-4 py-3 text-left text-sm transition ${
                  selected ? 'border-violet-400 bg-violet-500/15 text-white' : 'border-white/10 bg-white/5 text-slate-200 hover:border-white/25'
                }`}
              >
                <span className="block font-semibold">{area.area}</span>
                <span className="text-xs text-slate-400">
                  {area.location.lat.toFixed(4)}, {area.location.lng.toFixed(4)}
                </span>
              </button>
            );
          })}
        </div>
      ) : mode === 'custom' ? (
        <div className="space-y-3">
          <div>
            <label htmlFor="loc-label" className="label">Location label</label>
            <input
              id="loc-label"
              className="input-field"
              value={labelText}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="e.g. Home, Office"
              maxLength={60}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="loc-lat" className="label">Latitude</label>
              <input
                id="loc-lat"
                className="input-field"
                inputMode="decimal"
                value={latText}
                onChange={(e) => {
                  setLatText(e.target.value);
                  setLatDirty(true);
                  emitFromText(e.target.value, lngText);
                }}
              />
              {latError && <p className="field-error">{latError}</p>}
            </div>
            <div>
              <label htmlFor="loc-lng" className="label">Longitude</label>
              <input
                id="loc-lng"
                className="input-field"
                inputMode="decimal"
                value={lngText}
                onChange={(e) => {
                  setLngText(e.target.value);
                  setLngDirty(true);
                  emitFromText(latText, e.target.value);
                }}
              />
              {lngError && <p className="field-error">{lngError}</p>}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Suspense fallback={<MapFallback className="h-[280px] sm:h-[340px]" />}>
            <MeetingMap
              participants={[]}
              spots={[]}
              pinLocation={value?.location ?? null}
              pinDraggable
              onMapClick={handlePinCoords}
              onPinChange={handlePinCoords}
              fitKey="picker"
              className="h-[280px] sm:h-[340px]"
              ariaLabel="Pick your starting location on the map"
            />
          </Suspense>
          <p className="text-xs text-slate-400">
            Tap/click the map to place the pin, or drag the pin. Map: MapLibre + © OpenStreetMap contributors.
          </p>
          <div>
            <label htmlFor="loc-label-map" className="label">Location label</label>
            <input
              id="loc-label-map"
              className="input-field"
              value={labelText}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="e.g. Home, Office"
              maxLength={60}
            />
          </div>
          <button
            type="button"
            onClick={useGps}
            disabled={geo.status === 'requesting'}
            className="btn-secondary w-full !px-4 !py-2 text-sm"
          >
            {geo.status === 'requesting' ? 'Locating you…' : 'Use my GPS location'}
          </button>
          {gpsMessage && (
            <p role="status" className="text-xs text-slate-300">
              {gpsMessage}
            </p>
          )}
          <p className="text-xs text-slate-400">
            GPS is only requested when you tap the button above, and only this form's location is used. If GPS is
            unavailable or denied, pick on the map or enter coordinates instead.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <p className="mt-2 text-xs text-slate-400">
        {value
          ? `Selected: ${value.label} (${value.location.lat.toFixed(4)}, ${value.location.lng.toFixed(4)}). Locations expire after 2 hours.`
          : 'No location selected yet — choose an area, enter coordinates, or pick on the map. Locations expire after 2 hours.'}
      </p>
    </fieldset>
  );
}
