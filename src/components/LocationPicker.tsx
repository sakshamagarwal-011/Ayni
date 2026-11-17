import { lazy, Suspense, useState } from 'react';
import { STARTING_AREAS } from '../data/mockData';
import type { Coordinates } from '../types';
import { validateLat, validateLng } from '../lib/validation';
import { useGeolocation } from '../map/useGeolocation';
import { MapFallback } from './map/MapFallback';

// Lazy: the MapLibre chunk loads only when the map tab is opened.
const MeetingMap = lazy(() => import('./map/MeetingMap').then((m) => ({ default: m.MeetingMap })));

export interface LocationValue {
  location: Coordinates;
  label: string;
}

/**
 * Location picker: preset Bengaluru areas + manual lat/lng + map pin.
 * The map tab adds GPS (Browser Geolocation API, only on button press)
 * and click/drag pin placement on a MapLibre + OpenStreetMap map.
 * Preset/coordinate tabs remain as keyboard-accessible alternatives.
 */
export function LocationPicker({
  value,
  onChange,
  error,
}: {
  value: LocationValue;
  onChange: (v: LocationValue) => void;
  error?: string | null;
}) {
  const [mode, setMode] = useState<'preset' | 'custom' | 'map'>('preset');
  const [latText, setLatText] = useState(String(value.location.lat));
  const [lngText, setLngText] = useState(String(value.location.lng));
  const [gpsMessage, setGpsMessage] = useState<string | null>(null);
  const geo = useGeolocation();
  const latError = validateLat(Number(latText));
  const lngError = validateLng(Number(lngText));

  async function useGps() {
    setGpsMessage(null);
    try {
      const result = await geo.requestLocation();
      onChange({ location: result.coords, label: 'Current location (GPS)' });
      setGpsMessage(
        result.accuracyM !== null
          ? `GPS location set (accurate to about ${Math.round(result.accuracyM)} m). You can drag the pin to adjust it.`
          : 'GPS location set. You can drag the pin to adjust it.',
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
            const selected = value.label === area.area;
            return (
              <button
                key={area.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange({ location: area.location, label: area.area })}
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
              value={value.label}
              onChange={(e) => onChange({ ...value, label: e.target.value })}
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
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) onChange({ ...value, location: { ...value.location, lat: n } });
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
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) onChange({ ...value, location: { ...value.location, lng: n } });
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
              pinLocation={value.location}
              pinDraggable
              onMapClick={(coords) => onChange({ ...value, location: coords })}
              onPinChange={(coords) => onChange({ ...value, location: coords })}
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
              value={value.label}
              onChange={(e) => onChange({ ...value, label: e.target.value })}
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
        Selected: {value.label} ({value.location.lat.toFixed(4)}, {value.location.lng.toFixed(4)}). Locations expire after 2 hours.
      </p>
    </fieldset>
  );
}
