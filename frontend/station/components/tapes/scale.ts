/** Inclusive tick values: multiples of step within min..max. */
export function tapeTicks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

/** Normalises a heading in degrees into 0..360. */
export function wrapHeading(deg: number): number {
  const w = deg % 360;
  return w < 0 ? w + 360 : w;
}

/** Null samples rest at neutral 0, never at the tape min. */
export function restValue(v: number | null): number {
  return v ?? 0;
}

/** Readout text for one sample; null reads as dashes. */
export function formatSample(v: number | null, decimals: number): string {
  return v === null ? '---' : v.toFixed(decimals);
}

/** Degrees visible across the ruler at any rendered width. */
export const HEADING_SPAN_DEG = 120;

export interface HeadingMark {
  key: string;
  x: number;
  d: number;
}

const DEGS = Array.from({ length: 36 }, (_, k) => k * 10);
const COPIES = [-360, 0, 360];
const EPS = 1e-6;

/** Pixels per degree that hold the span as the width changes. */
export function headingPxPerDeg(w: number): number {
  return w / HEADING_SPAN_DEG;
}

/** Marks every 10°, tripled so the 0/360 seam stays covered. */
export function headingRuler(w: number): HeadingMark[] {
  const pxPerDeg = headingPxPerDeg(w);
  return COPIES.flatMap((off) =>
    DEGS.map((d) => ({ key: `${off}:${d}`, x: w / 2 + (d + off) * pxPerDeg, d })),
  );
}

/** The marks inside the window after translating for `hdg`. */
export function headingMarks(w: number, hdg: number): HeadingMark[] {
  const shift = hdg * headingPxPerDeg(w);
  return headingRuler(w).filter((m) => m.x - shift >= -EPS && m.x - shift <= w + EPS);
}

/** Where labels may show: the band, its box and their sizes. */
export interface LabelBand {
  /** Centre of the readout box, in band coordinates. */
  boxCentre: number;
  /** Half the span hidden behind the box. */
  hideHalf: number;
  /** Inset kept clear at each end of the band. */
  edge: number;
  /** Full length of the band. */
  len: number;
  /** Half a label's extent along the band. */
  half: number;
}

/** True when a label clears the readout box and both band ends. */
export function labelVisible(pos: number, b: LabelBand): boolean {
  if (Math.abs(pos - b.boxCentre) < b.hideHalf + b.half) return false;
  return pos - b.half >= b.edge && pos + b.half <= b.len - b.edge;
}
