import uPlot from 'uplot';

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
const DATE = '\n{YYYY}-{MM}-{DD}';
const HMS = '{HH}:{mm}:{ss}';
const HMSF = HMS + '.{fff}';
const SUBSEC = ':{ss}.{fff}';

/** Flight test reads UTC; the browser's zone must not leak in. */
export function utcDate(ts: number): Date {
  return uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC');
}

// uPlot's shape: [incr, tick, year, month, day, h, m, s, mode].
export const UTC_TIME_AXIS: (string | number | null)[][] = [
  [YEAR, '{YYYY}', null, null, null, null, null, null, 1],
  [DAY * 28, '{YYYY}-{MM}', null, null, null, null, null, null, 1],
  [DAY, '{YYYY}-{MM}-{DD}', null, null, null, null, null, null, 1],
  [HOUR, HMS, DATE, null, DATE, null, null, null, 1],
  [MIN, HMS, DATE, null, DATE, null, null, null, 1],
  [1, HMS, DATE, null, DATE, null, null, null, 1],
  // Mode 0: a rollover replaces the short tick, never appends to it.
  [1e-3, SUBSEC, HMSF + DATE, null, HMSF + DATE, HMSF, HMSF, null, 0],
];
