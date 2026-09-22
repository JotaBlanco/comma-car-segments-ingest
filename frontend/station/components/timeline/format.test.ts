import { describe, expect, it } from 'vitest';
import { fmtClock, fmtElapsed } from './format';

describe('timeline format', () => {
  it('formats UTC wall clock with tenths', () => {
    expect(fmtClock(Date.UTC(2026, 5, 5, 7, 18, 47, 258))).toBe('07:18:47.2');
  });
  it('formats elapsed m:ss', () => {
    expect(fmtElapsed(65_400)).toBe('1:05');
    expect(fmtElapsed(0)).toBe('0:00');
  });
});
