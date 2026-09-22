import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartTheme, resetChartTheme, withAlpha } from './colors';

const SERIES = [
  '--chart-s1',
  '--chart-s2',
  '--chart-s3',
  '--chart-s4',
  '--chart-s5',
  '--chart-s6',
  '--chart-s7',
  '--chart-s8',
];
const VARS = [
  '--text-muted',
  '--grid',
  '--accent',
  '--flown',
  '--gap',
  '--warn',
  '--select',
  '--alarm',
  ...SERIES,
];

function reader() {
  return vi.fn((name: string) => `value${name}`);
}

afterEach(() => {
  resetChartTheme();
});

describe('chartTheme', () => {
  it('maps each palette slot to its CSS variable', () => {
    const read = reader();
    expect(chartTheme('dark', read)).toEqual({
      text: 'value--text-muted',
      grid: 'value--grid',
      accent: 'value--accent',
      flown: 'value--flown',
      gap: 'value--gap',
      warn: 'value--warn',
      select: 'value--select',
      alarm: 'value--alarm',
      series: SERIES.map((name) => `value${name}`),
    });
    expect(read.mock.calls.map(([name]) => name)).toEqual(VARS);
  });

  it('reads each variable once per theme and reuses the cached palette', () => {
    const read = reader();
    const first = chartTheme('dark', read);
    const second = chartTheme('dark', read);
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(VARS.length);
  });

  it('reads again for a different theme', () => {
    const read = reader();
    chartTheme('dark', read);
    chartTheme('light', read);
    expect(read).toHaveBeenCalledTimes(VARS.length * 2);
  });

  it('re-reads after resetChartTheme', () => {
    const read = reader();
    const first = chartTheme('dark', read);
    resetChartTheme();
    const again = chartTheme('dark', read);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
    expect(read).toHaveBeenCalledTimes(VARS.length * 2);
  });
});

describe('withAlpha', () => {
  it('turns a 6-digit hex into rgba', () => {
    expect(withAlpha('#0064ff', 0.2)).toBe('rgba(0, 100, 255, 0.2)');
  });

  it('passes a non-hex colour through unchanged', () => {
    expect(withAlpha('rgba(0, 173, 255, 0.13)', 0.2)).toBe('rgba(0, 173, 255, 0.13)');
    expect(withAlpha('tomato', 0.2)).toBe('tomato');
  });

  it('passes a 3-digit hex through unchanged', () => {
    expect(withAlpha('#0cf', 0.2)).toBe('#0cf');
  });

  it('passes an 8-digit hex through unchanged', () => {
    expect(withAlpha('#0064ff33', 0.2)).toBe('#0064ff33');
  });
});
