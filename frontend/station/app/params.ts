import type { Catalog } from '../api/types';
import { log } from '../log';

/** What a caller may name when it opens the station. */
export interface EntryParams {
  /** The run id, matched against the catalog's `run_id`. */
  run: string;
  /** Signal names; the station picks the scope carrying each. */
  signals: string[];
  /** Playhead, epoch ms. */
  t?: number;
  /** Marked period [t0_ms, t1_ms]. */
  sel?: [number, number];
  /** The issue to tick, by its lake snippet id: it shows as an event from the start. */
  issue?: number;
}

/** The entry contract: `?run=&signal=&t=&sel=`. No run, no link. */
export function readEntryParams(search: string): EntryParams | null {
  const q = new URLSearchParams(search);
  const run = q.get('run');
  if (!run) return null;
  const out: EntryParams = { run, signals: q.getAll('signal').filter(Boolean) };
  const t = q.get('t');
  if (t !== null) {
    if (Number.isFinite(Number(t))) out.t = Number(t);
    else log.warn('params', 'dropped a non-numeric time', { t });
  }
  const sel = readWindow(q.get('sel'));
  if (sel) out.sel = sel;
  const issue = Number(q.get('issue'));
  if (Number.isInteger(issue) && issue > 0) out.issue = issue;
  return out;
}

function readWindow(raw: string | null): [number, number] | null {
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  const ok = parts.length === 2 && parts.every(Number.isFinite) && parts[0] < parts[1];
  if (!ok) log.warn('params', 'dropped a malformed period', { raw });
  return ok ? [parts[0], parts[1]] : null;
}

/** The aircraft and recording a run id names, or null when the lake lost it. */
export function findRecording(catalog: Catalog, run: string): { a: string; r: string } | null {
  for (const aircraft of catalog.aircraft) {
    for (const rec of aircraft.recordings) {
      if (rec.run_id === run) return { a: aircraft.id, r: rec.id };
    }
  }
  log.warn('params', 'the catalog holds no such run', { run });
  return null;
}
