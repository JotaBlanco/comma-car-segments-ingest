/** UTC wall clock as `HH:MM:SS.s`. */
export function fmtClock(tMs: number): string {
  const d = new Date(tMs);
  const p = (n: number) => String(n).padStart(2, '0');
  const tenth = Math.floor((tMs % 1000) / 100);
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${tenth}`;
}

/** Elapsed duration as `m:ss`. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
