import { describe, expect, it } from 'vitest';
import { UTC_TIME_AXIS } from './axisTime';

// uPlot takes the first row the tick increment reaches, in seconds.
function rowFor(incr: number): (string | number | null)[] {
  const last = UTC_TIME_AXIS[UTC_TIME_AXIS.length - 1];
  return UTC_TIME_AXIS.find((r) => incr >= (r[0] as number)) ?? last;
}

const TICK = 1;
const YEAR_COL = 2;
const HOUR_COL = 5;
const MIN_COL = 6;
const MODE = 8;

describe('UTC_TIME_AXIS', () => {
  it('orders rows from coarsest to finest increment', () => {
    const incrs = UTC_TIME_AXIS.map((r) => r[0] as number);
    expect(incrs).toEqual([...incrs].sort((a, b) => b - a));
  });

  it('prints only seconds and millis on sub-second ticks', () => {
    expect(rowFor(1e-3)[TICK]).toBe(':{ss}.{fff}');
  });

  it('replaces rather than appends on a sub-second rollover', () => {
    expect(rowFor(1e-3)[MODE]).toBe(0);
  });

  it('carries the full time on the first sub-second tick', () => {
    expect(rowFor(1e-3)[YEAR_COL]).toBe('{HH}:{mm}:{ss}.{fff}\n{YYYY}-{MM}-{DD}');
  });

  it('carries the full time when the hour or minute rolls over', () => {
    expect(rowFor(1e-3)[HOUR_COL]).toBe('{HH}:{mm}:{ss}.{fff}');
    expect(rowFor(1e-3)[MIN_COL]).toBe('{HH}:{mm}:{ss}.{fff}');
  });

  it('prints hours, minutes and seconds from one second up', () => {
    expect(rowFor(1)[TICK]).toBe('{HH}:{mm}:{ss}');
    expect(rowFor(60)[TICK]).toBe('{HH}:{mm}:{ss}');
    expect(rowFor(3600)[TICK]).toBe('{HH}:{mm}:{ss}');
  });
});
