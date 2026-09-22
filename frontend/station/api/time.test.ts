import { describe, expect, it } from 'vitest';
import { msToS, sToMs } from './time';

describe('msToS', () => {
  it('converts milliseconds to fractional seconds', () => {
    expect(msToS(1500)).toBe(1.5);
    expect(msToS(0)).toBe(0);
  });
});

describe('sToMs', () => {
  it('rounds to whole milliseconds', () => {
    expect(sToMs(1.5)).toBe(1500);
    expect(sToMs(0.0004)).toBe(0);
    expect(sToMs(1.2345)).toBe(1235);
  });

  it('round trips a millisecond timestamp', () => {
    const t = 1757683200123;
    expect(sToMs(msToS(t))).toBe(t);
  });
});
