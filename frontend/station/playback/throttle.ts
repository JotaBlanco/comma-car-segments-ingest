/** Gate true at most once per `ms` of wall time, not cursor time. */
export function makeThrottle(ms: number): () => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const now = performance.now();
    if (now - last < ms) return false;
    last = now;
    return true;
  };
}
