import { describe, expect, it } from 'vitest';
import {
  formatSample,
  headingMarks,
  headingPxPerDeg,
  HEADING_SPAN_DEG,
  labelVisible,
  restValue,
  tapeTicks,
  wrapHeading,
} from './scale';

function labels(w: number, hdg: number): number[] {
  return headingMarks(w, hdg)
    .filter((m) => m.d % 30 === 0)
    .map((m) => m.d);
}

describe('scale', () => {
  it('ticks are inclusive multiples of step', () => {
    expect(tapeTicks(0, 40, 10)).toEqual([0, 10, 20, 30, 40]);
  });
  it('wraps heading into 0..360', () => {
    expect(wrapHeading(-115.4)).toBeCloseTo(244.6);
    expect(wrapHeading(370)).toBe(10);
    expect(wrapHeading(0)).toBe(0);
  });
  it('rests null samples at neutral zero', () => {
    expect(restValue(null)).toBe(0);
    expect(restValue(-1500)).toBe(-1500);
  });
  it('reads null samples as dashes', () => {
    expect(formatSample(null, 0)).toBe('---');
    expect(formatSample(1234.56, 1)).toBe('1234.6');
  });
});

describe('heading ruler', () => {
  it('scales so the visible span is always 120 degrees', () => {
    expect(HEADING_SPAN_DEG).toBe(120);
    expect(headingPxPerDeg(1200)).toBe(10);
    expect(headingPxPerDeg(600)).toBe(5);
  });

  it('shows the same dozen 10-degree marks whatever the width', () => {
    // 13 when the heading lands on a mark, 12 between two.
    expect(headingMarks(1200, 0)).toHaveLength(13);
    expect(headingMarks(600, 0)).toHaveLength(13);
    expect(headingMarks(1600, 350)).toHaveLength(13);
    expect(headingMarks(849, 217)).toHaveLength(12);
    expect(headingMarks(400, 217)).toHaveLength(12);
  });

  it('never repeats a cardinal label inside the visible span', () => {
    for (const w of [400, 849, 1200, 1600]) {
      for (const hdg of [0, 45, 179, 217, 350]) {
        const shown = labels(w, hdg);
        expect(new Set(shown).size).toBe(shown.length);
        expect(shown.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it('keeps the marks around the seam at a northerly heading', () => {
    expect(labels(1200, 0)).toEqual([300, 330, 0, 30, 60]);
    expect(labels(1200, 350)).toEqual([300, 330, 0, 30]);
  });
});

describe('labelVisible', () => {
  // vertical tape space: band 0..174, box at 74, hide 14, edge 8, half 4
  const TAPE = { boxCentre: 74, hideHalf: 14, edge: 8, len: 174, half: 4 };
  const HDG = { boxCentre: 424.5, hideHalf: 37, edge: 8, len: 849, half: 11 };
  const v = (pos: number) => labelVisible(pos, TAPE);

  it('hides a label whose glyphs would touch the readout box', () => {
    expect(v(74)).toBe(false);
    expect(v(91)).toBe(false);
    expect(v(57)).toBe(false);
  });

  it('shows a label that clears the box by its own half height', () => {
    expect(v(92)).toBe(true);
    expect(v(56)).toBe(true);
  });

  it('hides a label that would be cut by either band end', () => {
    expect(v(11)).toBe(false);
    expect(v(163)).toBe(false);
  });

  it('shows a label that sits fully inside the inset band', () => {
    expect(v(12)).toBe(true);
    expect(v(162)).toBe(true);
  });

  it('works the same on the horizontal heading band', () => {
    expect(labelVisible(424, HDG)).toBe(false);
    expect(labelVisible(376, HDG)).toBe(true);
    expect(labelVisible(18, HDG)).toBe(false);
  });
});
