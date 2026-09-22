export function frameIndex(t0: number, dt: number, n: number, t: number): number {
  const k = Math.round((t - t0) / dt);
  return Math.min(n - 1, Math.max(0, k));
}

export function valueAt(col: ArrayLike<number | null>, idx: number): number | null {
  const v = col[idx];
  return v === undefined ? null : v;
}
