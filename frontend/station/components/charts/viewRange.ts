import type { FlightStateDto } from '../../api/types';

export interface ViewRange {
  t0_ms: number;
  t1_ms: number;
}

/** A uPlot drag rectangle, in plot-area pixels. */
export interface Selection {
  left: number;
  width: number;
}

const MIN_SPAN_MS = 5;

/** uPlot's drag threshold in px; below it the mouse only clicked. */
export const DRAG_DIST_PX = 4;

/** True when the pointer moved less than the drag threshold. */
export function isClick(dx: number, dist: number): boolean {
  return Math.abs(dx) < dist;
}

/** The recording's full extent, as a half-open window in ms. */
export function boundsOf(flight: FlightStateDto | null): ViewRange {
  const segs = flight?.segments ?? [];
  if (segs.length === 0) return { t0_ms: 0, t1_ms: 0 };
  return { t0_ms: segs[0].t0_ms, t1_ms: segs[segs.length - 1].t1_ms + 1 };
}

/** A drag rectangle as a ms window, never narrower than 5 ms. */
export function selectToRange(sel: Selection, posToMs: (px: number) => number): ViewRange | null {
  if (sel.width <= 0) return null;
  const a = posToMs(sel.left);
  const b = posToMs(sel.left + sel.width);
  const t0 = Math.round(Math.min(a, b));
  const t1 = Math.round(Math.max(a, b));
  if (t1 - t0 >= MIN_SPAN_MS) return { t0_ms: t0, t1_ms: t1 };
  // Whole ms only: the series query takes integer bounds.
  const mid = Math.round((t0 + t1) / 2);
  const lo = mid - Math.floor(MIN_SPAN_MS / 2);
  return { t0_ms: lo, t1_ms: lo + MIN_SPAN_MS };
}

/** True when either edge moved by a whole bucket or more. */
export function windowChanged(prev: ViewRange | null, next: ViewRange, bucketMs: number): boolean {
  if (prev === null) return true;
  return (
    Math.abs(next.t0_ms - prev.t0_ms) >= bucketMs || Math.abs(next.t1_ms - prev.t1_ms) >= bucketMs
  );
}

/** What a strip has on screen: which recording, over which window. */
export interface LoadedWindow {
  source: string;
  range: ViewRange;
}

/** True unless the same recording is loaded within a bucket. */
export function needsLoad(
  loaded: LoadedWindow | null,
  next: LoadedWindow,
  bucketMs: number,
): boolean {
  if (loaded === null || loaded.source !== next.source) return true;
  return windowChanged(loaded.range, next.range, bucketMs);
}
