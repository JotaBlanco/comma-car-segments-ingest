import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { log } from '../../log';
import { clock } from '../../playback/clock';
import { frameIndex, valueAt } from '../../playback/frames';
import { makeThrottle } from '../../playback/throttle';
import { fmtEventSpan } from '../../selection/events';
import { frameSpan } from '../../selection/summary';
import { useSession } from '../../store/session';
import { readCssVar } from '../../theme/cssVar';
import { aircraftIcon } from './aircraftIcon';
import { buildTrack } from './track';

// 10 Hz -> ~1.7 pts/s: under ~2k polyline points for a 20-min sortie
const STRIDE = 6;
const PAN_MS = 500;
// After a fit the follow-pan waits, so the first frames never drag the view off the journey.
const FIT_HOLD_MS = 1500;
const HOME: [number, number] = [51.668, -2.057];

interface Layers {
  flown: L.Polyline;
  ahead: L.Polyline;
  /** The leg inside the marked period, drawn over the track. */
  selected: L.Polyline;
  /** The picked snippets: a leg (or a dot) per event, in the alarm colour. */
  events: L.LayerGroup;
  ac: L.Marker;
}

type GRef = { current: SVGGElement | null };

function flownColor(): string {
  return readCssVar('--flown', '#00adff');
}

function aheadColor(): string {
  return readCssVar('--track-ahead', 'rgba(0, 173, 255, 0.55)');
}

function selectColor(): string {
  return readCssVar('--select', '#f5b342');
}

function alarmColor(): string {
  return readCssVar('--alarm', '#ff4040');
}

function themedIcon(): L.DivIcon {
  return aircraftIcon(readCssVar('--accent', '#00adff'), readCssVar('--bg', '#1a1a1b'));
}

function rotate(ac: L.Marker, g: GRef, hdg: number): void {
  if (!g.current) g.current = ac.getElement()?.querySelector<SVGGElement>('.ac') ?? null;
  if (g.current) g.current.style.transform = `rotate(${hdg}deg)`;
}

export default function MapView() {
  const flight = useSession((s) => s.flight);
  const config = useSession((s) => s.config);
  const follow = useSession((s) => s.follow);
  const setFollow = useSession((s) => s.setFollow);
  const theme = useSession((s) => s.theme);
  const selection = useSession((s) => s.selection);
  const events = useSession((s) => s.events);
  const aircraft = useSession((s) => s.aircraft);
  const recording = useSession((s) => s.recording);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<Layers | null>(null);
  const trackRef = useRef<ReturnType<typeof buildTrack> | null>(null);
  const gRef = useRef<SVGGElement | null>(null);
  const followRef = useRef(follow);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  useEffect(() => {
    const host = el.current;
    if (!host || map.current || !config) return;
    // Fractional zoom: a fitted journey fills the panel instead of the next integer level.
    const m = L.map(host, {
      zoomControl: true,
      zoomSnap: 0.25,
      attributionControl: !!config.tileUrl,
    });
    if (config.tileUrl) {
      L.tileLayer(config.tileUrl, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    } else {
      host.classList.add('map-blank');
      L.control.scale({ imperial: false }).addTo(m);
    }
    m.setView(HOME, 13);
    const flown = L.polyline([], { color: flownColor(), weight: 4, lineCap: 'round' }).addTo(m);
    const ahead = L.polyline([], {
      color: aheadColor(),
      weight: 3,
      dashArray: '7 6',
      lineCap: 'round',
    }).addTo(m);
    const selected = L.polyline([], {
      color: selectColor(),
      weight: 7,
      opacity: 0.55,
      lineCap: 'round',
      interactive: false,
    }).addTo(m);
    const eventLayer = L.layerGroup().addTo(m);
    const ac = L.marker(HOME, { icon: themedIcon(), interactive: false }).addTo(m);
    layers.current = { flown, ahead, selected, events: eventLayer, ac };
    map.current = m;
    log.info('map', 'map created', { tiles: config.tileUrl !== '' });
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(host);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      layers.current = null;
      trackRef.current = null;
      gRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    const ly = layers.current;
    if (!ly) return;
    ly.flown.setStyle({ color: flownColor() });
    ly.ahead.setStyle({ color: aheadColor() });
    ly.selected.setStyle({ color: selectColor() });
    ly.ac.setIcon(themedIcon());
    // setIcon replaces the element, so the cached <g> is stale
    gRef.current = null;
    log.debug('map', 'restyled for theme', { theme });
  }, [theme]);

  useEffect(() => {
    const m = map.current;
    const ly = layers.current;
    if (!m || !ly || !flight) return;
    const track = buildTrack(flight.cols.lat, flight.cols.lon, STRIDE);
    if (track.points.length === 0) {
      log.warn('map', 'no valid position frames', { aircraft, recording });
      return;
    }
    log.info('map', 'track built', { points: track.points.length, frames: flight.n });
    trackRef.current = track;
    ly.ahead.setLatLngs(track.points);
    ly.flown.setLatLngs([]);
    // The whole journey, at once: the panel may have been resized since the last flight, and
    // an animated fit would be cut short by the follow-pan of the first frame below.
    m.invalidateSize({ animate: false });
    m.fitBounds(L.latLngBounds(track.points).pad(0.1), { maxZoom: 15, animate: false });
    const settledAt = performance.now() + FIT_HOLD_MS;
    let lastPoint = -1;
    const panGate = makeThrottle(PAN_MS);
    const off = clock.subscribe((t) => {
      const i = frameIndex(flight.t0_ms, flight.dt_ms, flight.n, t);
      const lat = valueAt(flight.cols.lat, i);
      const lon = valueAt(flight.cols.lon, i);
      if (lat === null || lon === null) return;
      ly.ac.setLatLng([lat, lon]);
      rotate(ly.ac, gRef, valueAt(flight.cols.hdg, i) ?? 0);
      const p = track.frameToPoint[i];
      if (p !== lastPoint) {
        lastPoint = p;
        ly.flown.setLatLngs(track.points.slice(0, p + 1));
        ly.ahead.setLatLngs(track.points.slice(p));
      }
      if (
        followRef.current &&
        performance.now() > settledAt &&
        !m.getBounds().pad(-0.3).contains([lat, lon]) &&
        panGate()
      ) {
        m.panTo([lat, lon], { animate: true, duration: 0.4 });
      }
    });
    return off;
  }, [flight, aircraft, recording]);

  useEffect(() => {
    // The marked period as a leg of the track: the decimated points it spans.
    const ly = layers.current;
    const tr = trackRef.current;
    if (!ly || !tr || !flight) return;
    const span = selection ? frameSpan(flight, selection) : null;
    if (!span) {
      ly.selected.setLatLngs([]);
      return;
    }
    const [i0, i1] = span;
    const p0 = tr.frameToPoint[i0];
    const p1 = tr.frameToPoint[i1];
    ly.selected.setLatLngs(tr.points.slice(p0, p1 + 1));
    log.debug('map', 'selection drawn', { points: p1 - p0 + 1 });
  }, [flight, selection]);

  useEffect(() => {
    // Each picked snippet as the leg it covers; an instant as a dot. Hover names it.
    const ly = layers.current;
    const tr = trackRef.current;
    if (!ly || !tr || !flight) return;
    ly.events.clearLayers();
    const color = alarmColor();
    for (const e of events) {
      const span = frameSpan(flight, { t0_ms: e.t0_ms, t1_ms: Math.max(e.t1_ms, e.t0_ms) });
      if (!span) continue;
      const [i0, i1] = span;
      const pts = tr.points.slice(tr.frameToPoint[i0], tr.frameToPoint[i1] + 1);
      if (pts.length === 0) continue;
      const tip = `${e.label}<br>${fmtEventSpan(e)}`;
      if (pts.length > 1 && !e.instant) {
        L.polyline(pts, { color, weight: 6, opacity: 0.8, lineCap: 'round' })
          .bindTooltip(tip, { sticky: true })
          .addTo(ly.events);
      }
      L.circleMarker(pts[0], { radius: 5, color, weight: 2, fillColor: color, fillOpacity: 0.9 })
        .bindTooltip(tip)
        .addTo(ly.events);
    }
    log.debug('map', 'events drawn', { count: events.length });
  }, [flight, events, theme]);

  // isolate: Leaflet panes must not out-stack the PAT overlay.
  return (
    <div className="h-full relative isolate">
      <label className="absolute top-1 right-2 z-[500] text-xs flex items-center gap-1 bg-surface px-1 rounded">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />{' '}
        follow
      </label>
      <div ref={el} className="h-full w-full" />
    </div>
  );
}
