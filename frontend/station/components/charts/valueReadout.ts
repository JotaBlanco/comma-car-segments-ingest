const NO_SAMPLE = '---';

/** One value at 4 significant digits, as the strip range prints. */
export function fmtValue(n: number): string {
  return String(Number(n.toPrecision(4)));
}

/** UTC wall clock as `HH:MM:SS.fff`. */
export function fmtUtcMs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const hms = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return `${hms}.${p(d.getUTCMilliseconds(), 3)}`;
}

/** Index of the last time at or before `t`, or -1 if none is. */
export function indexAtOrBefore(t_ms: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = t_ms.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t_ms[mid] <= t) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit;
}

/** `HH:MM:SS.fff  value unit` for one sample, `---` without one. */
export function readoutText(t_ms: number | null, v: number | null, unit: string): string {
  if (t_ms === null || v === null || !Number.isFinite(v)) return NO_SAMPLE;
  const tail = unit ? ` ${unit}` : '';
  return `${fmtUtcMs(t_ms)}  ${fmtValue(v)}${tail}`;
}
