export interface Segment {
  t0: number;
  t1: number;
}

export function segmentIndex(segs: Segment[], t: number): number {
  return segs.findIndex((s) => t >= s.t0 && t <= s.t1);
}

/** In a segment stays; in a gap jumps on; past the end ends. */
export function advance(t: number, segs: Segment[]): { t: number; ended: boolean } {
  if (segs.length === 0) return { t, ended: true };
  if (segmentIndex(segs, t) >= 0) return { t, ended: false };
  const next = segs.find((s) => s.t0 > t);
  if (next) return { t: next.t0, ended: false };
  return { t: segs[segs.length - 1].t1, ended: true };
}

export function clampToSegments(t: number, segs: Segment[]): number {
  if (segs.length === 0) return t;
  if (t <= segs[0].t0) return segs[0].t0;
  return advance(t, segs).t;
}
