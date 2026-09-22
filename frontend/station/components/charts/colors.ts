import { readCssVar } from '../../theme/cssVar';
import type { Theme } from '../../theme/theme';

export interface ChartTheme {
  text: string;
  grid: string;
  accent: string;
  flown: string;
  gap: string;
  warn: string;
  /** The marked period's highlighter. */
  select: string;
  /** Events (picked snippets): the alarm colour. */
  alarm: string;
  /** Eight series colours, in chart assignment order. */
  series: string[];
}

const SERIES_VARS = [
  '--chart-s1',
  '--chart-s2',
  '--chart-s3',
  '--chart-s4',
  '--chart-s5',
  '--chart-s6',
  '--chart-s7',
  '--chart-s8',
];

const cache = new Map<Theme, ChartTheme>();

/** One theme's palette, read once: draw hooks run per frame. */
export function chartTheme(theme: Theme, read: (name: string) => string = readCssVar): ChartTheme {
  const cached = cache.get(theme);
  if (cached) return cached;
  const palette: ChartTheme = {
    text: read('--text-muted'),
    grid: read('--grid'),
    accent: read('--accent'),
    flown: read('--flown'),
    gap: read('--gap'),
    warn: read('--warn'),
    select: read('--select'),
    alarm: read('--alarm'),
    series: SERIES_VARS.map((name) => read(name)),
  };
  cache.set(theme, palette);
  return palette;
}

/** Drops the cache so the next call re-reads the CSS vars. */
export function resetChartTheme(): void {
  cache.clear();
}

const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** `#rrggbb` at the given alpha; other notations pass through. */
export function withAlpha(color: string, alpha: number): string {
  const m = HEX6.exec(color);
  if (!m) return color;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
