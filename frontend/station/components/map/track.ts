export interface Track {
  points: [number, number][];
  frameToPoint: Int32Array;
}

/** Valid frames decimated by `stride`, keeping the last one. */
export function buildTrack(lat: (number | null)[], lon: (number | null)[], stride: number): Track {
  const points: [number, number][] = [];
  const frameToPoint = new Int32Array(lat.length);
  let validSeen = 0;
  let lastValid = -1;
  for (let i = 0; i < lat.length; i++) {
    const la = lat[i];
    const lo = lon[i];
    if (la !== null && lo !== null) {
      lastValid = i;
      if (validSeen % stride === 0 || i === lat.length - 1) points.push([la, lo]);
      validSeen++;
    }
    frameToPoint[i] = Math.max(0, points.length - 1);
  }
  if (lastValid >= 0) {
    const la = lat[lastValid]!;
    const lo = lon[lastValid]!;
    const tail = points[points.length - 1];
    if (tail[0] !== la || tail[1] !== lo) points.push([la, lo]);
  }
  return { points, frameToPoint };
}
