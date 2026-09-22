const DAY_MS = 86_400_000;

export function formatDay(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (input: Date): number =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return iso.slice(0, 10);
}

// One rounding rule for every statistic, so a value reads the same on every screen.
export { formatStat } from "../files/format";

import { formatStat as roundStat } from "../files/format";

/** Print one optional statistic. A null or an absent number reads as a dash.
 *  `rms`, `p50`, `p95` and `p99` are optional on the wire (FR-DM-014): nobody
 *  has to measure them, and a percentile does not merge over two files. A blank
 *  must never read as a zero. */
export function optionalStat(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return roundStat(value);
}

export function baseDtype(dtype: string): string {
  return dtype.replace(/\d+$/, "");
}
