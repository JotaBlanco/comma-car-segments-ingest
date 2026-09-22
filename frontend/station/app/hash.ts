import { isWidgetInstanceId } from '../layout/panels';
import { log } from '../log';

export interface HashState {
  a?: string;
  r?: string;
  t?: number;
  s: string[];
  /** Collapsed widgets, by instance id. */
  c: string[];
  /** Zoom window [t0_ms, t1_ms]; absent = full extent. */
  v?: [number, number];
  /** Selected period [t0_ms, t1_ms]; absent = nothing selected. */
  sel?: [number, number];
  /** Picked data snippets (anomalies shown as events), by lake id; absent = none. */
  an?: number[];
}

export function parseHash(hash: string): HashState {
  try {
    return read(hash);
  } catch (e) {
    log.warn('hash', 'unreadable hash ignored', { error: String(e) });
    return { s: [], c: [] };
  }
}

function read(hash: string): HashState {
  const q = new URLSearchParams(hash.replace(/^#\/?/, ''));
  const t = q.get('t');
  const out: HashState = { s: q.getAll('s'), c: readCollapsed(q.get('c')) };
  const an = readIds(q.get('an'));
  if (an.length > 0) out.an = an;
  const a = q.get('a');
  const r = q.get('r');
  if (a) out.a = a;
  if (r) out.r = r;
  const v = readWindow(q.get('v'), 'zoom window');
  if (v) out.v = v;
  const sel = readWindow(q.get('sel'), 'selection');
  if (sel) out.sel = sel;
  if (t === null) return out;
  if (Number.isFinite(Number(t))) out.t = Number(t);
  else log.warn('hash', 'dropped a non-numeric time', { t });
  return out;
}

function readWindow(raw: string | null, what: string): [number, number] | null {
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  const ok = parts.length === 2 && parts.every(Number.isFinite) && parts[0] < parts[1];
  if (!ok) log.warn('hash', `dropped a malformed ${what}`, { raw });
  return ok ? [parts[0], parts[1]] : null;
}

function readIds(raw: string | null): number[] {
  if (!raw) return [];
  const ids = raw.split(',').map(Number);
  const ok = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (ok.length !== ids.length) log.warn('hash', 'dropped malformed snippet ids', { raw });
  return ok;
}

function readCollapsed(raw: string | null): string[] {
  if (!raw) return [];
  const ids = raw.split(',');
  const known = ids.filter(isWidgetInstanceId);
  if (known.length !== ids.length) log.warn('hash', 'dropped unknown panel ids', { raw });
  return known;
}

export function serializeHash(s: HashState): string {
  const q = new URLSearchParams();
  if (s.a) q.set('a', s.a);
  if (s.r) q.set('r', s.r);
  if (s.t !== undefined) q.set('t', String(Math.round(s.t)));
  for (const k of s.s) q.append('s', k);
  if (s.c.length > 0) q.set('c', s.c.join(','));
  if (s.v) q.set('v', `${Math.round(s.v[0])},${Math.round(s.v[1])}`);
  if (s.sel) q.set('sel', `${Math.round(s.sel[0])},${Math.round(s.sel[1])}`);
  if (s.an && s.an.length > 0) q.set('an', s.an.join(','));
  return `#/${q.toString()}`;
}

export function readHash(): HashState {
  return parseHash(window.location.hash);
}

/** Written on pause/stop/seek/pick/collapse, never the rAF loop. */
export function writeHash(s: HashState): void {
  const next = serializeHash(s);
  if (window.location.hash !== next) history.replaceState(null, '', next);
}
