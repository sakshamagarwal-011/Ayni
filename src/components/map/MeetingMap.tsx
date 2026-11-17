import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AttributionControl,
  Map,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  type MapMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { formatDistance, formatDuration, hasSpotDetails, initials } from '../../lib/utils';
import type { Coordinates, MeetingSpot, Participant } from '../../types';
import { midpointOf, progressGeometry, simplifyGeometry } from '../../engine/animation';
import { getMapConfig } from '../../map/config';
import { boundsForPoints, centreForPoints, isExpired, isExpiringSoon } from '../../map/geo';
import {
  buildBuildingsLayer,
  buildRasterFallbackStyle,
  canUseImmersive3D,
  findBuildingSource,
} from '../../map/style';

/**
 * The ONE MapLibre component. Every page renders its map through here.
 *
 * - Participant markers (coloured initials), spot pins, draggable manual
 *   pin, animated route polylines, 3D buildings where the style's data
 *   supports it, pitch/tilt + fly-to camera controls.
 * - Optional progressive route animation (animationRoutes + controlled
 *   progress): ghost full lines + revealed slices, destination pulse,
 *   travel-time labels, visibility filtering, and a capability-checked
 *   immersive 3D camera. Animation is driven by the parent and is
 *   independent of routing — geometries arrive already computed.
 * - Markers update in place when props change (Realtime refetches) —
 *   the map itself is created once and never recreated for data updates.
 * - Never crashes its page: WebGL/style failures render a text fallback
 *   with coordinates, and a Retry button re-initialises the map.
 * - Attribution is always shown (MapLibre AttributionControl).
 */

export interface MapRouteLine {
  participantId: string;
  spotId: string;
  /** [lng, lat] pairs. */
  geometry: number[][];
  color: string;
  label: string;
}

/**
 * One progressively-animated route. Geometries arrive already computed
 * (OSRM road geometry or labelled demo geometry); the map only reveals
 * them over time. Max 4 routes are animated (see MAX_ANIMATED_ROUTES).
 */
export interface AnimationRouteLine {
  participantId: string;
  color: string;
  /** [lng, lat] pairs, full geometry. Simplified internally for perf. */
  geometry: number[][];
  durationMin: number;
  distanceM: number;
  label: string;
}

export interface MeetingMapProps {
  participants: Participant[];
  spots: MeetingSpot[];
  selectedSpotId?: string | null;
  routes?: MapRouteLine[];
  pinLocation?: Coordinates | null;
  pinDraggable?: boolean;
  onMapClick?: (coords: Coordinates) => void;
  onPinChange?: (coords: Coordinates) => void;
  onSpotSelect?: (spotId: string) => void;
  showControls?: boolean;
  initialPitch?: number;
  /** Refit bounds when this value changes (spot change / explicit fit). */
  fitKey?: string;
  /** Smooth fly-to when the selected spot changes. */
  flyToSpot?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Progressive route animation (optional). When present, animated routes take precedence over `routes`. */
  animationRoutes?: AnimationRouteLine[];
  /** Controlled reveal progress 0..1 for animationRoutes. */
  animationProgress?: number;
  /** Whether animation playback is running (used to fit the camera once when playback starts). */
  animationPlaying?: boolean;
  /** Participant ids whose animated routes + labels are visible. Null/undefined = all. */
  visibleParticipantIds?: ReadonlySet<string> | null;
  /** Show a pulsing marker at the destination (selected spot or animationDestination). */
  destinationPulse?: boolean;
  /** Destination for the pulse marker. Defaults to the selected spot's location. */
  animationDestination?: Coordinates | null;
  /** Immersive 3D camera (pitch 60 + buildings) when supported; falls back to 2D with a note. */
  immersive3D?: boolean;
  /** Called when the user grabs the map (mouse/touch/wheel) — parents pause playback on this. */
  onCameraInteraction?: () => void;
  /** Called when immersive-3D support resolves/changes, so parents can enable/disable the toggle. */
  onImmersiveSupportChange?: (supported: boolean, reason: string) => void;
}

const ROUTE_SOURCE_ID = 'meetsync-routes';
const ROUTE_CASING_ID = 'meetsync-routes-casing';
const ROUTE_LINE_ID = 'meetsync-routes-line';
const ANIM_SOURCE_ID = 'meetsync-animated-routes';
const ANIM_GHOST_ID = 'meetsync-animated-routes-ghost';
const ANIM_LINE_ID = 'meetsync-animated-routes-line';
const BUILDINGS_LAYER_ID = 'meetsync-3d-buildings';
const MAX_ANIMATED_ROUTES = 4;
const MAX_ANIMATED_POINTS = 500;
const BENGALURU_CENTER: Coordinates = { lat: 12.9716, lng: 77.6412 };

/** Marching-ants dash steps, cycled by requestAnimationFrame. */
const DASH_STEPS: number[][] = [
  [0, 4, 3],
  [0.5, 4, 3],
  [1, 4, 3],
  [1.5, 4, 3],
  [2, 4, 3],
  [2.5, 4, 3],
  [3, 4, 3],
  [3.5, 4, 3],
];

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isWebGlSupported(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function MeetingMap({
  participants,
  spots,
  selectedSpotId = null,
  routes = [],
  pinLocation = null,
  pinDraggable = false,
  onMapClick,
  onPinChange,
  onSpotSelect,
  showControls = true,
  initialPitch = 0,
  fitKey,
  flyToSpot = false,
  className = 'h-[320px] sm:h-[420px]',
  ariaLabel = 'Map of participants, meeting spots, and routes',
  animationRoutes = [],
  animationProgress = 1,
  animationPlaying = false,
  visibleParticipantIds = null,
  destinationPulse = false,
  animationDestination = null,
  immersive3D = false,
  onCameraInteraction,
  onImmersiveSupportChange,
}: MeetingMapProps) {
  const config = getMapConfig();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const markersRef = useRef(new globalThis.Map<string, { marker: Marker; signature: string }>());
  const labelMarkersRef = useRef(new globalThis.Map<string, Marker>());
  const pulseMarkerRef = useRef<Marker | null>(null);
  const pinMarkerRef = useRef<Marker | null>(null);
  const rafRef = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const fitDoneRef = useRef(false);
  const fallbackTriedRef = useRef(false);
  const lastFitKeyRef = useRef(fitKey);
  const lastSelectedRef = useRef(selectedSpotId);
  const prevPlayingRef = useRef(false);
  const reducedMotionRef = useRef(prefersReducedMotion());
  const cameraCallbackRef = useRef(onCameraInteraction);
  cameraCallbackRef.current = onCameraInteraction;
  const supportCallbackRef = useRef(onImmersiveSupportChange);
  supportCallbackRef.current = onImmersiveSupportChange;

  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'error' | 'unsupported'>(
    isWebGlSupported() ? 'loading' : 'unsupported',
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [usingRasterFallback, setUsingRasterFallback] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [pitch, setPitch] = useState(initialPitch);
  const [buildingsOn, setBuildingsOn] = useState(config.map3dEnabled);
  const [buildingsAvailable, setBuildingsAvailable] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [immersiveNote, setImmersiveNote] = useState<string | null>(null);
  // Ref mirror so style-load callbacks (captured once at init) never use a stale toggle value.
  const buildingsOnRef = useRef(buildingsOn);
  buildingsOnRef.current = buildingsOn;

  // Animated routes: simplified once per route-set change (never per frame),
  // capped at 4 routes / 500 points for mid-range Android performance.
  const animRoutes = useMemo(
    () =>
      animationRoutes.slice(0, MAX_ANIMATED_ROUTES).map((r) => ({
        ...r,
        geometry: simplifyGeometry(r.geometry, MAX_ANIMATED_POINTS),
      })),
    [animationRoutes],
  );
  const visibleKey = useMemo(
    () => (visibleParticipantIds === null ? 'all' : [...visibleParticipantIds].sort().join(',')),
    [visibleParticipantIds],
  );
  const animRef = useRef({ routes: animRoutes, progress: animationProgress, visibleKey, visibleIds: visibleParticipantIds });
  animRef.current = { routes: animRoutes, progress: animationProgress, visibleKey, visibleIds: visibleParticipantIds };

  const pulseDestination = useMemo<Coordinates | null>(() => {
    if (animationDestination) return animationDestination;
    const spot = spots.find((s) => s.id === selectedSpotId);
    return spot ? spot.location : null;
  }, [animationDestination, spots, selectedSpotId]);
  const propsRef = useRef({ participants, spots, selectedSpotId, routes, pinLocation, pinDraggable, onMapClick, onPinChange, onSpotSelect });
  propsRef.current = { participants, spots, selectedSpotId, routes, pinLocation, pinDraggable, onMapClick, onPinChange, onSpotSelect };

  const allPoints = useMemo(() => {
    const pts: Coordinates[] = [];
    for (const p of participants) if (p.location) pts.push({ lat: p.location.lat, lng: p.location.lng });
    for (const s of spots) pts.push(s.location);
    if (pinLocation) pts.push(pinLocation);
    return pts;
  }, [participants, spots, pinLocation]);

  const initialCenter = useMemo(() => {
    const c = centreForPoints(allPoints) ?? BENGALURU_CENTER;
    return [c.lng, c.lat] as [number, number];
  }, [allPoints]);

  /* ---------- custom layers (routes + buildings), re-added after any style load ---------- */

  const ensureCustomLayers = () => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    try {
      if (!map.getSource(ROUTE_SOURCE_ID)) {
        map.addSource(ROUTE_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
      }
      if (!map.getLayer(ROUTE_CASING_ID)) {
        map.addLayer({
          id: ROUTE_CASING_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 8, 'line-opacity': 0.22 },
        });
      }
      if (!map.getLayer(ROUTE_LINE_ID)) {
        map.addLayer({
          id: ROUTE_LINE_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 3.5,
            'line-opacity': 0.95,
            'line-dasharray': reducedMotionRef.current ? [1, 0] : DASH_STEPS[0],
          },
        });
      }
      if (!map.getSource(ANIM_SOURCE_ID)) {
        map.addSource(ANIM_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
      }
      if (!map.getLayer(ANIM_GHOST_ID)) {
        map.addLayer({
          id: ANIM_GHOST_ID,
          type: 'line',
          source: ANIM_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'ghost'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.18 },
        });
      }
      if (!map.getLayer(ANIM_LINE_ID)) {
        map.addLayer({
          id: ANIM_LINE_ID,
          type: 'line',
          source: ANIM_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'progress'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 4.5, 'line-opacity': 0.98 },
        });
      }
      syncRouteData();
      syncAnimatedData();
      ensureBuildings();
    } catch {
      // A style in transition can reject layer adds; the next styledata
      // event retries. Never let this crash the page.
    }
  };

  const ensureBuildings = () => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    // VITE_MAP_3D_ENABLED=false is a master switch, not just the initial
    // toggle state: never add the layer when it is off.
    if (!config.map3dEnabled) {
      if (map.getLayer(BUILDINGS_LAYER_ID)) {
        try {
          map.setLayoutProperty(BUILDINGS_LAYER_ID, 'visibility', 'none');
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (!buildingsOnRef.current) {
      if (map.getLayer(BUILDINGS_LAYER_ID)) {
        try {
          map.setLayoutProperty(BUILDINGS_LAYER_ID, 'visibility', 'none');
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (map.getLayer(BUILDINGS_LAYER_ID)) {
      try {
        map.setLayoutProperty(BUILDINGS_LAYER_ID, 'visibility', 'visible');
      } catch {
        /* ignore */
      }
      setBuildingsAvailable('yes');
      return;
    }
    try {
      const style = map.getStyle();
      const source = findBuildingSource(style);
      if (!source) {
        setBuildingsAvailable('no');
        return;
      }
      const beforeId = style.layers.find((l) => l.type === 'symbol')?.id;
      map.addLayer(buildBuildingsLayer(source), beforeId);
      setBuildingsAvailable('yes');
    } catch {
      setBuildingsAvailable('no');
    }
  };

  const syncRouteData = () => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource(ROUTE_SOURCE_ID) as { setData?: (data: unknown) => void } | undefined;
    if (!source?.setData) return;
    // Animated routes take precedence for their participants, but
    // routes beyond the animation cap (MAX_ANIMATED_ROUTES) still draw
    // in the legacy layer — otherwise participants 5+ get no line at
    // all while their legend/ETA entries still show.
    const { routes: lines } = propsRef.current;
    const animatedIds = new Set(animRef.current.routes.map((r) => r.participantId));
    const visible = lines.filter((l) => !animatedIds.has(l.participantId));
    source.setData({
      type: 'FeatureCollection',
      features: visible
        .filter((l) => l.geometry.length >= 2)
        .map((l) => ({
          type: 'Feature',
          properties: { color: l.color, participantId: l.participantId, spotId: l.spotId },
          geometry: { type: 'LineString', coordinates: l.geometry },
        })),
    });
  };

  /** Write animated routes (ghost full lines + progress slices) in ONE setData per update. No React state. */
  const syncAnimatedData = () => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource(ANIM_SOURCE_ID) as { setData?: (data: unknown) => void } | undefined;
    if (!source?.setData) return;
    const { routes: lines, progress, visibleIds } = animRef.current;
    const features: unknown[] = [];
    for (const line of lines) {
      if (visibleIds !== null && !visibleIds.has(line.participantId)) continue;
      if (line.geometry.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { kind: 'ghost', color: line.color, participantId: line.participantId },
        geometry: { type: 'LineString', coordinates: line.geometry },
      });
      const revealed = progressGeometry(line.geometry, progress);
      if (revealed.length >= 2) {
        features.push({
          type: 'Feature',
          properties: { kind: 'progress', color: line.color, participantId: line.participantId },
          geometry: { type: 'LineString', coordinates: revealed },
        });
      }
    }
    source.setData({ type: 'FeatureCollection', features });
  };

  /** Travel-time labels: one non-interactive pill per visible route, at the route midpoint. */
  const syncAnimationLabels = () => {
    const map = mapRef.current;
    if (!map) return;
    const { routes: lines, visibleIds } = animRef.current;
    const seen = new Set<string>();
    for (const line of lines) {
      if (visibleIds !== null && !visibleIds.has(line.participantId)) continue;
      const mid = midpointOf(line.geometry);
      if (!mid) continue;
      const key = line.participantId;
      seen.add(key);
      const text = `${line.label} · ${formatDuration(line.durationMin)} · ${formatDistance(line.distanceM)}`;
      const existing = labelMarkersRef.current.get(key);
      if (existing) {
        const el = existing.getElement();
        if (el.textContent !== text) el.textContent = text;
        existing.setLngLat([mid[0], mid[1]]);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'meetsync-route-label';
      el.setAttribute('aria-hidden', 'true');
      el.style.pointerEvents = 'none';
      el.textContent = text;
      const marker = new Marker({ element: el, anchor: 'center' }).setLngLat([mid[0], mid[1]]).addTo(map);
      labelMarkersRef.current.set(key, marker);
    }
    for (const [key, marker] of labelMarkersRef.current) {
      if (!seen.has(key)) {
        marker.remove();
        labelMarkersRef.current.delete(key);
      }
    }
  };

  /** Destination pulse marker: CSS ring animation (static under reduced motion, via CSS). */
  const syncPulseMarker = () => {
    const map = mapRef.current;
    if (!map) return;
    if (!destinationPulse || !pulseDestination) {
      pulseMarkerRef.current?.remove();
      pulseMarkerRef.current = null;
      return;
    }
    if (pulseMarkerRef.current) {
      pulseMarkerRef.current.setLngLat([pulseDestination.lng, pulseDestination.lat]);
      return;
    }
    const el = document.createElement('div');
    el.className = 'meetsync-destination-pulse';
    el.setAttribute('aria-hidden', 'true');
    el.style.pointerEvents = 'none';
    pulseMarkerRef.current = new Marker({ element: el, anchor: 'center' })
      .setLngLat([pulseDestination.lng, pulseDestination.lat])
      .addTo(map);
  };

  /* ---------- camera ---------- */

  const fitToPoints = (animate: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const { participants: ps, spots: ss, pinLocation: pin } = propsRef.current;
    const pts: Coordinates[] = [];
    for (const p of ps) if (p.location) pts.push({ lat: p.location.lat, lng: p.location.lng });
    for (const s of ss) pts.push(s.location);
    if (pin) pts.push(pin);
    const bounds = boundsForPoints(pts);
    // Reduced motion: never animate the camera.
    const duration = animate && !reducedMotionRef.current ? 900 : 0;
    if (!bounds) {
      map.easeTo({ center: [BENGALURU_CENTER.lng, BENGALURU_CENTER.lat], zoom: 12, duration: animate && !reducedMotionRef.current ? 800 : 0 });
      return;
    }
    map.fitBounds(bounds, { padding: { top: 48, bottom: 48, left: 40, right: 40 }, maxZoom: 15, duration });
  };

  /* ---------- markers ---------- */

  const syncMarkers = () => {
    const map = mapRef.current;
    if (!map) return;
    const { participants: ps, spots: ss, selectedSpotId: selected, onSpotSelect: onSelect } = propsRef.current;
    const seen = new Set<string>();

    for (const p of ps) {
      if (!p.location) continue;
      const key = `p:${p.id}`;
      const expired = isExpired(p.location);
      const expiring = !expired && isExpiringSoon(p.location);
      const signature = `${p.location.lat},${p.location.lng},${p.displayName},${p.location.label},${p.isReady},${expired},${expiring},${p.location.updatedAt}`;
      seen.add(key);
      const existing = markersRef.current.get(key);
      if (existing && existing.signature === signature) continue;
      existing?.marker.remove();
      const el = document.createElement('div');
      el.className = 'meetsync-participant-marker';
      el.setAttribute('aria-label', `${p.displayName} at ${p.location.label}`);
      el.style.cssText = [
        'width:36px;height:36px;border-radius:9999px;display:flex;align-items:center;justify-content:center',
        'color:#fff;font-weight:700;font-size:13px;border:2px solid #fff;cursor:pointer',
        `background-color:${p.avatarColor};box-shadow:0 2px 10px rgba(0,0,0,.45);opacity:${expired ? 0.45 : 1}`,
      ].join(';');
      el.textContent = initials(p.displayName);
      const popup = new Popup({ closeButton: false, closeOnClick: true, offset: 18, maxWidth: '260px' }).setHTML(
        `<div><strong>${escapeHtml(p.displayName)}</strong>${p.isReady ? ' · Ready' : ''}<br/>` +
          `${escapeHtml(p.location.label)}<br/>` +
          `<span>Updated ${escapeHtml(formatTime(p.location.updatedAt))}` +
          `${expired ? ' · <span>Location expired</span>' : expiring ? ' · <span>Expiring soon</span>' : ''}</span></div>`,
      );
      const marker = new Marker({ element: el, anchor: 'center' })
        .setLngLat([p.location.lng, p.location.lat])
        .setPopup(popup)
        .addTo(map);
      markersRef.current.set(key, { marker, signature });
    }

    for (const s of ss) {
      const key = `s:${s.id}`;
      const selectedNow = selected === s.id;
      const signature = `${s.location.lat},${s.location.lng},${s.name},${selectedNow}`;
      seen.add(key);
      const existing = markersRef.current.get(key);
      if (existing && existing.signature === signature) continue;
      existing?.marker.remove();
      const el = document.createElement('div');
      el.className = 'meetsync-spot-marker';
      el.setAttribute('aria-label', `Meeting spot: ${s.name}`);
      el.setAttribute('role', 'button');
      el.style.cssText = [
        'width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer',
        'border:2px solid #fff;transform:rotate(-45deg);border-radius:50% 50% 50% 0',
        `background-color:${selectedNow ? '#a78bfa' : '#7c3aed'};box-shadow:0 2px 10px rgba(0,0,0,.45)`,
        selectedNow ? 'outline:3px solid rgba(167,139,250,.55);outline-offset:2px' : '',
      ].join(';');
      const inner = document.createElement('span');
      inner.style.cssText = 'transform:rotate(45deg);color:#fff;font-weight:700;font-size:13px;line-height:1';
      inner.textContent = s.name.charAt(0).toUpperCase();
      el.appendChild(inner);
      if (onSelect) {
        el.addEventListener('click', () => onSelect(s.id));
      }
      const popup = new Popup({ closeButton: false, closeOnClick: true, offset: 20, maxWidth: '260px' }).setHTML(
        `<div><strong>${escapeHtml(s.name)}</strong><br/>${escapeHtml(s.address)}<br/>` +
          // Live places carry no rating/opening data — show the
          // category alone rather than invented values.
          `<span>${escapeHtml(s.category)}${hasSpotDetails(s) ? ` · ★ ${s.rating.toFixed(1)} · ${s.openNow ? 'Open now' : 'Closed now'}` : ''}</span></div>`,
      );
      const marker = new Marker({ element: el, anchor: 'bottom' })
        .setLngLat([s.location.lng, s.location.lat])
        .setPopup(popup)
        .addTo(map);
      markersRef.current.set(key, { marker, signature });
    }

    for (const [key, entry] of markersRef.current) {
      if (!seen.has(key)) {
        entry.marker.remove();
        markersRef.current.delete(key);
      }
    }
  };

  const syncPinMarker = () => {
    const map = mapRef.current;
    if (!map) return;
    const { pinLocation: pin, pinDraggable: draggable } = propsRef.current;
    if (!pin) {
      pinMarkerRef.current?.remove();
      pinMarkerRef.current = null;
      return;
    }
    if (pinMarkerRef.current) {
      pinMarkerRef.current.setLngLat([pin.lng, pin.lat]);
      pinMarkerRef.current.setDraggable(draggable);
      return;
    }
    const el = document.createElement('div');
    el.className = 'meetsync-pin-marker';
    el.setAttribute('aria-label', 'Selected location pin');
    el.style.cssText = [
      'width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:grab',
      'border:2px solid #fff;transform:rotate(-45deg);border-radius:50% 50% 50% 0',
      'background-color:#2563eb;box-shadow:0 2px 12px rgba(0,0,0,.5)',
    ].join(';');
    const inner = document.createElement('span');
    inner.style.cssText = 'width:10px;height:10px;border-radius:9999px;background:#fff;transform:rotate(45deg)';
    el.appendChild(inner);
    const marker = new Marker({ element: el, anchor: 'bottom', draggable })
      .setLngLat([pin.lng, pin.lat])
      .addTo(map);
    marker.on('dragend', () => {
      const ll = marker.getLngLat();
      propsRef.current.onPinChange?.({ lat: ll.lat, lng: ll.lng });
    });
    pinMarkerRef.current = marker;
  };

  /* ---------- map lifecycle: create once, remove on unmount/retry ---------- */

  useEffect(() => {
    if (mapStatus === 'unsupported') return;
    const container = containerRef.current;
    if (!container) return;
    loadedRef.current = false;
    fitDoneRef.current = false;
    fallbackTriedRef.current = false;
    markersRef.current.clear();
    pinMarkerRef.current = null;
    // Settles once the map loads or fails terminally; the load timeout
    // below only fires while the map is still genuinely pending.
    let settled = false;

    let map: Map;
    try {
      map = new Map({
        container,
        style: config.styleUrl,
        center: initialCenter,
        zoom: 12,
        pitch: initialPitch,
        attributionControl: false,
        maxZoom: 19,
      });
    } catch (err) {
      settled = true;
      setErrorMessage(err instanceof Error ? err.message : 'Map failed to start.');
      setMapStatus('error');
      supportCallbackRef.current?.(false, 'The map failed to start.');
      return;
    }
    mapRef.current = map;
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new ScaleControl({ maxWidth: 80, unit: 'metric' }), 'bottom-left');

    const onStyleReady = () => {
      if (loadedRef.current) {
        ensureCustomLayers();
        return;
      }
      loadedRef.current = true;
      settled = true;
      setMapStatus('ready');
      setErrorMessage(null);
      ensureCustomLayers();
      syncMarkers();
      syncPinMarker();
      if (!fitDoneRef.current) {
        fitDoneRef.current = true;
        fitToPoints(false);
      }
    };
    const onLoad = () => onStyleReady();
    const onStyleData = () => {
      if (map.isStyleLoaded()) onStyleReady();
    };
    const onError = (e: { error?: Error; sourceId?: string; tile?: unknown }) => {
      if (loadedRef.current) return; // Ignore later tile errors once loaded.
      // Only STYLE-load failures abandon the vector style. A single
      // failed tile/glyph/source error before load must not trigger
      // the raster fallback (or the error overlay on the second one).
      if (e.sourceId !== undefined || e.tile !== undefined) return;
      if (!fallbackTriedRef.current) {
        fallbackTriedRef.current = true;
        setUsingRasterFallback(true);
        try {
          map.setStyle(buildRasterFallbackStyle(config.rasterFallbackUrl));
        } catch (err) {
          settled = true;
          setErrorMessage(err instanceof Error ? err.message : 'Map style failed to load.');
          setMapStatus('error');
          supportCallbackRef.current?.(false, 'The map style failed to load.');
        }
        return;
      }
      settled = true;
      setErrorMessage(e.error?.message ?? 'Map failed to load.');
      setMapStatus('error');
      supportCallbackRef.current?.(false, 'The map failed to load.');
    };
    const onClick = (e: MapMouseEvent) => {
      propsRef.current.onMapClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    };
    const onUserGrab = () => {
      cameraCallbackRef.current?.();
    };
    map.on('load', onLoad);
    map.on('styledata', onStyleData);
    map.on('error', onError);
    map.on('click', onClick);
    map.on('mousedown', onUserGrab);
    map.on('touchstart', onUserGrab);
    map.on('wheel', onUserGrab);

    // Load timeout: a hanging style request must not leave "Loading
    // map…" on screen forever with no retry path.
    const loadTimeout = setTimeout(() => {
      if (settled || loadedRef.current) return;
      settled = true;
      setErrorMessage('The map took too long to load. Check your connection and try again.');
      setMapStatus('error');
      supportCallbackRef.current?.(false, 'The map failed to load.');
    }, 20_000);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            try {
              map.resize();
            } catch {
              /* ignore */
            }
          })
        : null;
    resizeObserver?.observe(container);

    return () => {
      clearTimeout(loadTimeout);
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
      for (const marker of labelMarkersRef.current.values()) marker.remove();
      labelMarkersRef.current.clear();
      pulseMarkerRef.current?.remove();
      pulseMarkerRef.current = null;
      pinMarkerRef.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // Re-run only on retry. Props flow through refs/effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey]);

  /* ---------- data sync: markers + routes update without recreating the map ---------- */

  useEffect(() => {
    if (mapStatus !== 'ready') return;
    syncMarkers();
    syncPinMarker();
    syncRouteData();
    // Re-run when inputs change; signatures avoid redundant marker rebuilds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, spots, selectedSpotId, routes, pinLocation, pinDraggable, mapStatus]);

  /* ---------- animated routes: data + labels + pulse (no map recreation, no per-frame state) ---------- */

  useEffect(() => {
    if (mapStatus !== 'ready') return;
    syncAnimatedData();
    syncAnimationLabels();
    syncPulseMarker();
    // Removing animated routes must restore the legacy layer (it draws
    // the routes the animation cap leaves out — see syncRouteData).
    syncRouteData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animRoutes, animationProgress, visibleKey, destinationPulse, pulseDestination, mapStatus]);

  /* ---------- route dash animation (paused when hidden; static if reduced motion; off when animated routes present) ---------- */

  useEffect(() => {
    if (mapStatus !== 'ready' || reducedMotionRef.current || routes.length === 0 || animRoutes.length > 0) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    let step = 0;
    let last = 0;
    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (document.hidden || now - last < 90) return;
      last = now;
      step = (step + 1) % DASH_STEPS.length;
      const map = mapRef.current;
      if (map && map.getLayer(ROUTE_LINE_ID)) {
        try {
          map.setPaintProperty(ROUTE_LINE_ID, 'line-dasharray', DASH_STEPS[step]);
        } catch {
          /* layer mid-transition; next tick retries */
        }
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [mapStatus, routes, animRoutes]);

  /* ---------- fit once when animation playback starts from the beginning ---------- */

  useEffect(() => {
    const wasPlaying = prevPlayingRef.current;
    prevPlayingRef.current = animationPlaying;
    if (!wasPlaying && animationPlaying && animationProgress === 0 && mapStatus === 'ready') {
      fitToPoints(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationPlaying, animationProgress, mapStatus]);

  /* ---------- immersive 3D: capability-checked pitch + buildings, 2D fallback with a note ---------- */

  // Camera + buildings state captured when immersive mode is applied,
  // so turning it off (or losing support while on) restores the view
  // instead of leaving the map pitched with buildings forced on.
  const immersivePrevRef = useRef<{ pitch: number; bearing: number; buildingsOn: boolean } | null>(null);
  const immersiveAppliedRef = useRef(false);

  // Report unsupported immediately when WebGL is unavailable, so the
  // parent's 3D toggle never sits on "Checking…" forever.
  useEffect(() => {
    if (mapStatus === 'unsupported') {
      supportCallbackRef.current?.(false, 'WebGL is not available on this device.');
    }
  }, [mapStatus]);

  useEffect(() => {
    if (mapStatus !== 'ready') return;
    const support = canUseImmersive3D({
      webglSupported: true,
      buildingsAvailable,
      usingRasterFallback,
      map3dEnabled: config.map3dEnabled,
    });
    supportCallbackRef.current?.(support.supported, support.reason);
    const restoreCamera = () => {
      if (!immersiveAppliedRef.current) return;
      immersiveAppliedRef.current = false;
      const prev = immersivePrevRef.current;
      immersivePrevRef.current = null;
      const pitch = prev?.pitch ?? initialPitch;
      const bearing = prev?.bearing ?? 0;
      const map = mapRef.current;
      if (map) {
        if (reducedMotionRef.current) {
          map.jumpTo({ pitch, bearing });
        } else {
          map.easeTo({ pitch, bearing, duration: 900 });
        }
      }
      setPitch(pitch);
      if (prev) setBuildingsOn(prev.buildingsOn);
    };
    if (!immersive3D) {
      restoreCamera();
      setImmersiveNote(null);
      return;
    }
    if (!support.supported) {
      restoreCamera();
      setImmersiveNote(`${support.reason} Showing the 2D map.`);
      return;
    }
    setImmersiveNote(null);
    const map = mapRef.current;
    if (!map) return;
    if (!immersiveAppliedRef.current) {
      immersivePrevRef.current = {
        pitch: map.getPitch(),
        bearing: map.getBearing(),
        buildingsOn: buildingsOnRef.current,
      };
      immersiveAppliedRef.current = true;
    }
    if (!buildingsOn) setBuildingsOn(true);
    if (reducedMotionRef.current) {
      map.jumpTo({ pitch: 60, bearing: 15 });
    } else {
      map.easeTo({ pitch: 60, bearing: 15, duration: 900 });
    }
    setPitch(60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immersive3D, buildingsAvailable, usingRasterFallback, mapStatus]);

  /* ---------- fit on explicit fitKey changes only (never on every realtime tick) ---------- */

  useEffect(() => {
    if (fitKey === undefined || fitKey === lastFitKeyRef.current) return;
    lastFitKeyRef.current = fitKey;
    if (mapStatus === 'ready') fitToPoints(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, mapStatus]);

  /* ---------- fly-to on selected-spot change ---------- */

  useEffect(() => {
    if (!flyToSpot || selectedSpotId === lastSelectedRef.current) return;
    const map = mapRef.current;
    const spot = spots.find((s) => s.id === selectedSpotId);
    if (!map || mapStatus !== 'ready' || !spot) return;
    // Record the selection only after a successful fly-to: if the spot
    // changed before the map was ready, the pending fly-to must not be
    // silently skipped on the next run.
    lastSelectedRef.current = selectedSpotId;
    const target = { center: [spot.location.lng, spot.location.lat] as [number, number], zoom: Math.max(map.getZoom(), 14.5) };
    if (reducedMotionRef.current) {
      map.jumpTo(target);
    } else {
      map.flyTo({ ...target, duration: 1400, essential: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpotId, flyToSpot, mapStatus]);

  /* ---------- buildings toggle ---------- */

  useEffect(() => {
    if (mapStatus === 'ready') ensureBuildings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildingsOn, mapStatus]);

  /* ---------- cursor for pin-picking ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = onMapClick ? 'crosshair' : '';
  }, [onMapClick, mapStatus]);

  const setPitchDegrees = (degrees: number) => {
    setPitch(degrees);
    const map = mapRef.current;
    if (!map) return;
    if (reducedMotionRef.current) map.jumpTo({ pitch: degrees });
    else map.easeTo({ pitch: degrees, duration: 600 });
  };

  const resetBearing = () => {
    const map = mapRef.current;
    if (!map) return;
    if (reducedMotionRef.current) map.jumpTo({ bearing: 0 });
    else map.easeTo({ bearing: 0, duration: 600 });
  };

  const retry = () => {
    setErrorMessage(null);
    setUsingRasterFallback(false);
    setMapStatus('loading');
    setRetryKey((k) => k + 1);
  };

  /* ---------- fallbacks: text list so the page stays useful without WebGL/a style ---------- */

  const textFallback = (
    <div className="p-4 text-sm text-slate-200">
      <p className="font-semibold text-white">Map unavailable — locations as text</p>
      <ul className="mt-3 space-y-2">
        {participants
          .filter((p) => p.location)
          .map((p) => (
            <li key={p.id}>
              {p.displayName} — {p.location!.label} ({p.location!.lat.toFixed(4)}, {p.location!.lng.toFixed(4)})
              {isExpired(p.location!) ? ' · location expired' : ''}
            </li>
          ))}
        {spots.map((s) => (
          <li key={s.id}>
            Spot: {s.name} — {s.address} ({s.location.lat.toFixed(4)}, {s.location.lng.toFixed(4)})
          </li>
        ))}
        {pinLocation && (
          <li>
            Pinned location ({pinLocation.lat.toFixed(4)}, {pinLocation.lng.toFixed(4)})
          </li>
        )}
        {participants.every((p) => !p.location) && spots.length === 0 && !pinLocation && <li>No locations yet.</li>}
      </ul>
    </div>
  );

  if (mapStatus === 'unsupported') {
    return (
      <div className="glass-card overflow-hidden" role="status" aria-label="Map unavailable">
        <p className="border-b border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
          Your browser does not support WebGL, which the interactive map needs. The locations are listed below instead.
        </p>
        {textFallback}
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-navy-900">
      <div
        ref={containerRef}
        className={className}
        role="application"
        tabIndex={0}
        aria-label={ariaLabel}
        style={{ width: '100%' }}
      />
      {mapStatus === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-navy-900/70" role="status" aria-label="Map loading">
          <span className="inline-flex items-center gap-2 text-sm text-slate-300">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-violet-400" />
            Loading map…
          </span>
        </div>
      )}
      {mapStatus === 'error' && (
        <div className="absolute inset-0 overflow-y-auto bg-navy-900/95 p-4" role="alert">
          <p className="font-semibold text-rose-100">Map failed to load</p>
          <p className="mt-1 text-sm text-slate-300">
            {errorMessage ?? 'The map style or tiles could not be loaded. Check your connection and try again.'}
          </p>
          <button type="button" onClick={retry} className="btn-secondary mt-3 !px-4 !py-2 text-xs">
            Retry map
          </button>
          <div className="mt-4 border-t border-white/10 pt-2">{textFallback}</div>
        </div>
      )}
      {showControls && mapStatus === 'ready' && (
        <div className="absolute left-2 top-2 flex flex-col gap-1.5" aria-label="Map view controls">
          <div className="flex gap-1 rounded-lg bg-navy-900/90 p-1 shadow-lg" role="group" aria-label="Camera tilt">
            {[0, 45, 60].map((deg) => (
              <button
                key={deg}
                type="button"
                onClick={() => setPitchDegrees(deg)}
                aria-pressed={pitch === deg}
                className={`rounded-md px-2 py-1 text-xs font-medium ${pitch === deg ? 'bg-violet-600 text-white' : 'text-slate-200 hover:bg-white/10'}`}
              >
                {deg}°
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setBuildingsOn((v) => !v)}
            disabled={buildingsAvailable === 'no' || !config.map3dEnabled}
            title={
              !config.map3dEnabled
                ? '3D buildings are disabled in settings'
                : buildingsAvailable === 'no'
                  ? '3D buildings are not available for this map style'
                  : 'Toggle 3D building extrusion (where map data supports it)'
            }
            aria-pressed={buildingsOn}
            className="rounded-lg bg-navy-900/90 px-2 py-1.5 text-left text-xs font-medium text-slate-200 shadow-lg hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            3D buildings {buildingsAvailable === 'no' ? '(unavailable)' : buildingsOn ? '· on' : '· off'}
          </button>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => fitToPoints(true)}
              className="rounded-lg bg-navy-900/90 px-2 py-1.5 text-xs font-medium text-slate-200 shadow-lg hover:bg-navy-800"
            >
              Fit all
            </button>
            <button
              type="button"
              onClick={resetBearing}
              className="rounded-lg bg-navy-900/90 px-2 py-1.5 text-xs font-medium text-slate-200 shadow-lg hover:bg-navy-800"
            >
              Reset north
            </button>
          </div>
        </div>
      )}
      {usingRasterFallback && mapStatus === 'ready' && (
        <p className="absolute bottom-8 left-2 rounded-lg bg-navy-900/90 px-2 py-1 text-[11px] text-amber-200 shadow-lg" role="status">
          Vector style unavailable — showing raster fallback (© OpenStreetMap contributors).
        </p>
      )}
      {immersiveNote && mapStatus === 'ready' && (
        <p className="absolute bottom-8 right-2 max-w-[70%] rounded-lg bg-navy-900/90 px-2 py-1 text-[11px] text-slate-200 shadow-lg" role="status">
          3D unavailable on this device/map — showing 2D map. {immersiveNote}
        </p>
      )}
    </div>
  );
}
