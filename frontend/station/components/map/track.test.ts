import { describe, expect, it } from 'vitest';
import { buildTrack } from './track';

describe('buildTrack', () => {
  it('skips nulls, decimates by stride, maps every frame to a point index', () => {
    const lat = [51, null, 51.1, 51.2, 51.3];
    const lon = [-2, null, -2.1, -2.2, -2.3];
    const t = buildTrack(lat, lon, 2);
    expect(t.points).toEqual([
      [51, -2],
      [51.2, -2.2],
      [51.3, -2.3],
    ]);
    expect(Array.from(t.frameToPoint)).toEqual([0, 0, 0, 1, 2]);
  });

  it('returns no points when every frame is null', () => {
    const t = buildTrack([null, null], [null, null], 2);
    expect(t.points).toEqual([]);
    expect(Array.from(t.frameToPoint)).toEqual([0, 0]);
  });
});
