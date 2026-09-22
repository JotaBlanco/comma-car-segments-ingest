import { describe, expect, it } from 'vitest';
import type { FlightStateDto } from '../../api/types';
import { boundsOf, isClick, needsLoad, selectToRange, windowChanged } from './viewRange';

/** A 1 px = 10 ms plot starting at t=1000. */
const posToMs = (px: number) => 1000 + px * 10;

function flight(segments: { t0_ms: number; t1_ms: number }[]): FlightStateDto {
  return {
    segments: segments.map((s, i) => ({ ...s, chunk_seq: i })),
  } as FlightStateDto;
}

describe('boundsOf', () => {
  it('spans the first segment start to just past the last end', () => {
    expect(
      boundsOf(
        flight([
          { t0_ms: 100, t1_ms: 200 },
          { t0_ms: 500, t1_ms: 900 },
        ]),
      ),
    ).toEqual({
      t0_ms: 100,
      t1_ms: 901,
    });
  });

  it('is an empty window with no flight state', () => {
    expect(boundsOf(null)).toEqual({ t0_ms: 0, t1_ms: 0 });
    expect(boundsOf(flight([]))).toEqual({ t0_ms: 0, t1_ms: 0 });
  });
});

describe('selectToRange', () => {
  it('maps the drag rectangle to a ms window', () => {
    expect(selectToRange({ left: 20, width: 100 }, posToMs)).toEqual({
      t0_ms: 1200,
      t1_ms: 2200,
    });
  });

  it('keeps a short drag as dragged', () => {
    expect(selectToRange({ left: 100, width: 10 }, posToMs)).toEqual({
      t0_ms: 2000,
      t1_ms: 2100,
    });
    expect(selectToRange({ left: 100, width: 2 }, posToMs)).toEqual({
      t0_ms: 2000,
      t1_ms: 2020,
    });
  });

  it('widens a flick to the minimum span, in whole milliseconds', () => {
    const range = selectToRange({ left: 100, width: 0.2 }, posToMs);
    expect(range).toEqual({ t0_ms: 1999, t1_ms: 2004 });
    expect(Number.isInteger(range?.t0_ms)).toBe(true);
    expect(Number.isInteger(range?.t1_ms)).toBe(true);
  });

  it('is null when nothing was dragged', () => {
    expect(selectToRange({ left: 40, width: 0 }, posToMs)).toBeNull();
  });
});

describe('windowChanged', () => {
  it('always loads when nothing is loaded yet', () => {
    expect(windowChanged(null, { t0_ms: 0, t1_ms: 1000 }, 10)).toBe(true);
  });

  it('ignores a shift smaller than one bucket', () => {
    const prev = { t0_ms: 1000, t1_ms: 2000 };
    expect(windowChanged(prev, { t0_ms: 1005, t1_ms: 2004 }, 10)).toBe(false);
  });

  it('reloads once an edge moves a whole bucket', () => {
    const prev = { t0_ms: 1000, t1_ms: 2000 };
    expect(windowChanged(prev, { t0_ms: 1000, t1_ms: 2010 }, 10)).toBe(true);
  });
});

describe('needsLoad', () => {
  const win = { t0_ms: 1000, t1_ms: 2000 };

  it('loads when nothing is loaded yet', () => {
    expect(needsLoad(null, { source: 'sn003/r1', range: win }, 10)).toBe(true);
  });

  it('reloads for another recording even at the same window', () => {
    const loaded = { source: 'sn003/r1', range: win };
    expect(needsLoad(loaded, { source: 'sn003/r2', range: win }, 10)).toBe(true);
  });

  it('skips a window shift smaller than one bucket', () => {
    const loaded = { source: 'sn003/r1', range: win };
    const next = { source: 'sn003/r1', range: { t0_ms: 1005, t1_ms: 2004 } };
    expect(needsLoad(loaded, next, 10)).toBe(false);
  });

  it('reloads once an edge moves a whole bucket', () => {
    const loaded = { source: 'sn003/r1', range: win };
    const next = { source: 'sn003/r1', range: { t0_ms: 1000, t1_ms: 2010 } };
    expect(needsLoad(loaded, next, 10)).toBe(true);
  });
});

describe('isClick', () => {
  it('is a click while the pointer stays under the threshold', () => {
    expect(isClick(0, 4)).toBe(true);
    expect(isClick(3, 4)).toBe(true);
    expect(isClick(-3, 4)).toBe(true);
  });

  it('is a drag from the threshold up', () => {
    expect(isClick(4, 4)).toBe(false);
    expect(isClick(-40, 4)).toBe(false);
  });
});
