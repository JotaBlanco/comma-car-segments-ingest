import { describe, expect, it } from 'vitest';
import { fmtUtcMs, indexAtOrBefore, readoutText } from './valueReadout';

const T = Date.UTC(2026, 5, 5, 16, 11, 16, 850);

describe('fmtUtcMs', () => {
  it('prints the UTC wall clock with milliseconds', () => {
    expect(fmtUtcMs(T)).toBe('16:11:16.850');
  });

  it('pads every field', () => {
    expect(fmtUtcMs(Date.UTC(2026, 0, 1, 4, 5, 6, 7))).toBe('04:05:06.007');
  });
});

describe('indexAtOrBefore', () => {
  it('is -1 when there are no samples', () => {
    expect(indexAtOrBefore([], 10)).toBe(-1);
  });

  it('is -1 before the first sample', () => {
    expect(indexAtOrBefore([10, 20, 30], 9)).toBe(-1);
  });

  it('finds an exact hit', () => {
    expect(indexAtOrBefore([10, 20, 30], 20)).toBe(1);
    expect(indexAtOrBefore([10, 20, 30], 10)).toBe(0);
  });

  it('takes the previous sample in between', () => {
    expect(indexAtOrBefore([10, 20, 30], 29)).toBe(1);
  });

  it('takes the last sample after the end', () => {
    expect(indexAtOrBefore([10, 20, 30], 99)).toBe(2);
  });
});

describe('readoutText', () => {
  it('prints the time, the value and the unit', () => {
    expect(readoutText(T, 0.0412, 'Volt')).toBe('16:11:16.850  0.0412 Volt');
  });

  it('omits an empty unit', () => {
    expect(readoutText(T, 12345.678, '')).toBe('16:11:16.850  12350');
  });

  it('is a dash when there is no sample', () => {
    expect(readoutText(T, null, 'Volt')).toBe('---');
    expect(readoutText(null, 1, 'Volt')).toBe('---');
  });
});
