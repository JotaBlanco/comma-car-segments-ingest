import { describe, expect, it } from 'vitest';
import type { SeriesDto } from '../../api/types';
import { stripData } from './stripData';

function makeSeries(over: Partial<SeriesDto> = {}): SeriesDto {
  return {
    table: 'a429',
    scope: 'INS1',
    signal: 'pitch_angle',
    unit: 'deg',
    count: 120,
    t_ms: [1000, 1500, 2000],
    v: [1, 2, null],
    ...over,
  };
}

describe('stripData', () => {
  it('is null when the series carries no samples', () => {
    expect(stripData(makeSeries({ t_ms: [], v: [] }))).toBeNull();
  });

  it('builds x values in seconds from t_ms', () => {
    const data = stripData(makeSeries());
    if (data === null) throw new Error('expected strip data');
    expect(Array.from(data[0])).toEqual([1, 1.5, 2]);
  });

  it('passes the single value column through, gaps and all', () => {
    const series = makeSeries();
    const data = stripData(series);
    if (data === null) throw new Error('expected strip data');
    expect(data).toHaveLength(2);
    expect(data[1]).toBe(series.v);
  });
});
