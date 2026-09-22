import { describe, expect, it } from 'vitest';
import { gapRanges } from './plugins';

describe('gapRanges', () => {
  it('returns the spans between consecutive segments in seconds', () => {
    expect(
      gapRanges([
        { t0: 1000, t1: 3000 },
        { t0: 6000, t1: 8000 },
        { t0: 9000, t1: 9500 },
      ]),
    ).toEqual([
      { t0: 3, t1: 6 },
      { t0: 8, t1: 9 },
    ]);
  });

  it('has no gaps for fewer than two segments', () => {
    expect(gapRanges([])).toEqual([]);
    expect(gapRanges([{ t0: 1000, t1: 3000 }])).toEqual([]);
  });
});
