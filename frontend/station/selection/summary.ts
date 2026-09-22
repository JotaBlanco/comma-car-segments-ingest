import type { ColName, FlightStateDto } from '../api/types';
import { valueAt } from '../playback/frames';

export interface TimeRange {
  t0_ms: number;
  t1_ms: number;
}

/** One flight-state parameter across the selection. */
export interface ParamDelta {
  col: ColName;
  label: string;
  unit: string;
  start: number;
  end: number;
  /** end - start; headings wrap into -180..180. */
  delta: number;
  min: number;
  max: number;
}

export interface SelectionSummary {
  t0_ms: number;
  t1_ms: number;
  span_ms: number;
  /** Flight-state frames inside the selection. */
  frames: number;
  /** Ground track length in metres, null without two positions. */
  distance_m: number | null;
  params: ParamDelta[];
}

/** The parameters the bar reports, in this order. */
const PARAMS: { col: ColName; label: string }[] = [
  { col: 'alt', label: 'Altitude' },
  { col: 'gs', label: 'Ground speed' },
  { col: 'cas', label: 'CAS' },
  { col: 'hdg', label: 'Heading' },
  { col: 'vs', label: 'Vertical speed' },
];

const EARTH_M = 6_371_000;

/** Great-circle distance in metres. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A heading change folded into -180..180. */
export function wrapDeg(d: number): number {
  let x = ((d + 180) % 360) - 180;
  if (x < -180) x += 360;
  return x;
}

/** The frame indexes [i0, i1] the range covers, or null when it misses the flight. */
export function frameSpan(flight: FlightStateDto, r: TimeRange): [number, number] | null {
  const i0 = Math.max(0, Math.ceil((r.t0_ms - flight.t0_ms) / flight.dt_ms));
  const i1 = Math.min(flight.n - 1, Math.floor((r.t1_ms - flight.t0_ms) / flight.dt_ms));
  return i1 >= i0 ? [i0, i1] : null;
}

/** Running first/last/min/max over the samples fed in; nulls are skipped. */
class Extent {
  start: number | null = null;
  end: number | null = null;
  min = Infinity;
  max = -Infinity;
  samples = 0;

  add(v: number | null | undefined): void {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    if (this.start === null) this.start = v;
    this.end = v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    this.samples++;
  }

  /** The measurements, or null when nothing was fed in. */
  done(): { start: number; end: number; min: number; max: number; samples: number } | null {
    if (this.start === null || this.end === null) return null;
    return {
      start: this.start,
      end: this.end,
      min: this.min,
      max: this.max,
      samples: this.samples,
    };
  }
}

function paramDelta(
  flight: FlightStateDto,
  col: ColName,
  label: string,
  i0: number,
  i1: number,
): ParamDelta | null {
  const values = flight.cols[col];
  if (!values) return null;
  const ext = new Extent();
  for (let i = i0; i <= i1; i++) ext.add(valueAt(values, i));
  const e = ext.done();
  if (!e) return null;
  const delta = col === 'hdg' ? wrapDeg(e.end - e.start) : e.end - e.start;
  return {
    col,
    label,
    unit: flight.units[col] ?? '',
    start: e.start,
    end: e.end,
    delta,
    min: e.min,
    max: e.max,
  };
}

/** Ground track length over the frames, skipping missing positions. */
export function trackDistance(flight: FlightStateDto, i0: number, i1: number): number | null {
  let prev: [number, number] | null = null;
  let total = 0;
  let legs = 0;
  for (let i = i0; i <= i1; i++) {
    const lat = valueAt(flight.cols.lat, i);
    const lon = valueAt(flight.cols.lon, i);
    if (lat === null || lon === null) continue;
    if (prev) {
      total += haversine(prev[0], prev[1], lat, lon);
      legs++;
    }
    prev = [lat, lon];
  }
  return legs > 0 ? total : null;
}

/** What the selection bar shows for a time range of the flight. */
export function summarize(flight: FlightStateDto, r: TimeRange): SelectionSummary {
  const span = frameSpan(flight, r);
  const base = { t0_ms: r.t0_ms, t1_ms: r.t1_ms, span_ms: r.t1_ms - r.t0_ms };
  if (!span) return { ...base, frames: 0, distance_m: null, params: [] };
  const [i0, i1] = span;
  const params: ParamDelta[] = [];
  for (const p of PARAMS) {
    const d = paramDelta(flight, p.col, p.label, i0, i1);
    if (d) params.push(d);
  }
  return { ...base, frames: i1 - i0 + 1, distance_m: trackDistance(flight, i0, i1), params };
}

/** A strip's own series across the selection. */
export interface SeriesDelta {
  start: number;
  end: number;
  delta: number;
  min: number;
  max: number;
  samples: number;
}

export function seriesDelta(
  t_ms: number[],
  v: (number | null)[],
  r: TimeRange,
): SeriesDelta | null {
  const ext = new Extent();
  for (let i = 0; i < t_ms.length; i++) {
    if (t_ms[i] < r.t0_ms) continue;
    if (t_ms[i] > r.t1_ms) break;
    ext.add(v[i]);
  }
  const e = ext.done();
  return e ? { ...e, delta: e.end - e.start } : null;
}

const NM_M = 1852;

/** `12.4 km · 6.7 NM`, or metres under a kilometre. */
export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km · ${(m / NM_M).toFixed(1)} NM`;
}

/** `1h 02m 05s` / `2m 05s` / `12.5 s`, whatever reads best for the span. */
export function fmtSpan(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const whole = Math.round(s);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}h ${mm}m ${ss}s` : `${m}m ${ss}s`;
}

/** A signed value with a unit, to a sensible precision: `+123 ft`, `-0.42 g`. */
export function fmtDelta(v: number, unit: string): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
  return `${sign}${fmtNum(Math.abs(v))}${unit ? ` ${unit}` : ''}`;
}

export function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
