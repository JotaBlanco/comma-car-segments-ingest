import { fmtValue } from '../charts/valueReadout';

/** Lowest and highest value the loaded window holds, gaps aside. */
export function seriesRange(v: (number | null)[]): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const x of v) {
    if (x === null || !Number.isFinite(x)) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return min === Infinity ? null : [min, max];
}

/** The window's extent for the strip header: `min … max unit`. */
export function fmtRange(range: [number, number] | null, unit: string): string {
  if (range === null) return 'no samples';
  const [min, max] = range;
  const tail = unit ? ` ${unit}` : '';
  return `${fmtValue(min)} … ${fmtValue(max)}${tail}`;
}
