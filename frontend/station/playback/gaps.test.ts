import { describe, expect, it } from 'vitest';
import { advance, clampToSegments, segmentIndex } from './gaps';

const segs = [
  { t0: 1000, t1: 3000 },
  { t0: 6000, t1: 8000 },
];

describe('gaps', () => {
  it('finds the enclosing segment', () => {
    expect(segmentIndex(segs, 2000)).toBe(0);
    expect(segmentIndex(segs, 4000)).toBe(-1);
    expect(segmentIndex(segs, 8000)).toBe(1);
  });
  it('advance jumps over a gap to the next segment start', () => {
    expect(advance(3500, segs)).toEqual({ t: 6000, ended: false });
    expect(advance(2000, segs)).toEqual({ t: 2000, ended: false });
  });
  it('advance ends at the last segment end', () => {
    expect(advance(9000, segs)).toEqual({ t: 8000, ended: true });
  });
  it('clamp pulls a gap time to the next segment start and bounds the ends', () => {
    expect(clampToSegments(4000, segs)).toBe(6000);
    expect(clampToSegments(0, segs)).toBe(1000);
    expect(clampToSegments(9999, segs)).toBe(8000);
  });
});
