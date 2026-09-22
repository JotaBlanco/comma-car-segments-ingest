import type { SnippetDto } from '../api/types';

/** A picked snippet as the panels draw it: a period on the time axis with a short label. */
export interface FlightEvent {
  id: number;
  label: string;
  t0_ms: number;
  t1_ms: number;
  /** A snippet that marks one instant, not a span. */
  instant: boolean;
}

/** `bus=INS1` -> `INS1`; a scope-less snippet has no source to show. */
export function scopeValue(scope: string | null): string | null {
  if (!scope) return null;
  const i = scope.indexOf('=');
  return i >= 0 ? scope.slice(i + 1) : scope;
}

/** The short name a panel has room for: signal and source, else the snippet's name. */
export function eventLabel(s: SnippetDto): string {
  const src = scopeValue(s.scope);
  if (s.signal) return src ? `${s.signal} · ${src}` : s.signal;
  return s.name;
}

/** The picked snippets that carry a period, in time order; undated ones cannot be drawn. */
export function pickedEvents(snippets: SnippetDto[], picked: number[]): FlightEvent[] {
  const on = new Set(picked);
  const out: FlightEvent[] = [];
  for (const s of snippets) {
    if (!on.has(s.id) || s.t0_ms === null || s.t1_ms === null) continue;
    out.push({
      id: s.id,
      label: eventLabel(s),
      t0_ms: s.t0_ms,
      t1_ms: s.t1_ms,
      instant: s.t1_ms <= s.t0_ms,
    });
  }
  return out.sort((a, b) => a.t0_ms - b.t0_ms);
}

/** `1.2 s`, `450 ms`, `2m 05s`, or `instant`. */
export function fmtEventSpan(e: FlightEvent): string {
  const ms = e.t1_ms - e.t0_ms;
  if (ms <= 0) return 'instant';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
