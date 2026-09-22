import { describe, expect, it } from 'vitest';
import { fmtRange, seriesRange } from './readout';

describe('seriesRange', () => {
  it('ignores the gap nulls', () => {
    expect(seriesRange([null, 3, null, -1.5, 2])).toEqual([-1.5, 3]);
  });

  it('is null when nothing was loaded', () => {
    expect(seriesRange([])).toBeNull();
    expect(seriesRange([null, null])).toBeNull();
  });
});

describe('fmtRange', () => {
  it('trims the precision and appends the unit', () => {
    expect(fmtRange([-1.4111328125, 0.8613281], 'Deg/Sec')).toBe('-1.411 … 0.8613 Deg/Sec');
  });

  it('omits an empty unit and marks an empty window', () => {
    expect(fmtRange([0, 10], '')).toBe('0 … 10');
    expect(fmtRange(null, 'deg')).toBe('no samples');
  });
});
