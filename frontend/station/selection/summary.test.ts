import { describe, expect, it } from 'vitest';
import type { FlightStateDto } from '../api/types';
import {
  fmtDelta,
  fmtDistance,
  fmtNum,
  fmtSpan,
  frameSpan,
  haversine,
  seriesDelta,
  summarize,
  wrapDeg,
} from './summary';

const T0 = 1_000_000;

function flight(): FlightStateDto {
  const n = 10;
  const line = (f: (i: number) => number | null) => Array.from({ length: n }, (_, i) => f(i));
  return {
    t0_ms: T0,
    dt_ms: 1000,
    n,
    segments: [{ t0_ms: T0, t1_ms: T0 + 9000, chunk_seq: 0 }],
    markers: [],
    cols: {
      lat: line((i) => 51 + i * 0.001),
      lon: line(() => -2),
      alt: line((i) => 100 + i * 10),
      pitch: line(() => 0),
      roll: line(() => 0),
      hdg: line((i) => (350 + i * 4) % 360),
      gs: line((i) => (i === 3 ? null : 100 + i)),
      cas: line(() => null),
      tas: line(() => 0),
      vs: line((i) => i),
      phase: line(() => 2),
      fcs: line(() => 1),
    },
    units: {
      lat: '°',
      lon: '°',
      alt: 'ft',
      pitch: '°',
      roll: '°',
      hdg: '°',
      gs: 'kt',
      cas: 'kt',
      tas: 'kt',
      vs: 'ft/min',
      phase: '',
      fcs: '',
    },
    source: {} as FlightStateDto['source'],
    texts: {},
  };
}

describe('frameSpan', () => {
  it('rounds inward to the frames the range covers', () => {
    expect(frameSpan(flight(), { t0_ms: T0 + 1500, t1_ms: T0 + 4200 })).toEqual([2, 4]);
  });
  it('clamps to the flight and rejects a range past its end', () => {
    expect(frameSpan(flight(), { t0_ms: T0 - 5000, t1_ms: T0 + 500 })).toEqual([0, 0]);
    expect(frameSpan(flight(), { t0_ms: T0 + 20_000, t1_ms: T0 + 30_000 })).toBeNull();
  });
});

describe('summarize', () => {
  it('reports the span, the frames, the ground track and each parameter delta', () => {
    const s = summarize(flight(), { t0_ms: T0 + 2000, t1_ms: T0 + 6000 });
    expect(s.span_ms).toBe(4000);
    expect(s.frames).toBe(5);
    // 4 legs of 0.001° latitude, ~111 m each
    expect(s.distance_m).toBeGreaterThan(440);
    expect(s.distance_m).toBeLessThan(446);
    const alt = s.params.find((p) => p.col === 'alt')!;
    expect(alt).toMatchObject({ start: 120, end: 160, delta: 40, min: 120, max: 160, unit: 'ft' });
  });
  it('skips missing samples and drops parameters with no data', () => {
    const s = summarize(flight(), { t0_ms: T0 + 2000, t1_ms: T0 + 4000 });
    const gs = s.params.find((p) => p.col === 'gs')!;
    expect(gs).toMatchObject({ start: 102, end: 104, delta: 2 });
    expect(s.params.some((p) => p.col === 'cas')).toBe(false);
  });
  it('folds a heading change across north', () => {
    const s = summarize(flight(), { t0_ms: T0, t1_ms: T0 + 4000 });
    const hdg = s.params.find((p) => p.col === 'hdg')!;
    expect(hdg.start).toBe(350);
    expect(hdg.end).toBe(6);
    expect(hdg.delta).toBe(16);
  });
  it('is empty when the range misses the flight', () => {
    const s = summarize(flight(), { t0_ms: T0 + 50_000, t1_ms: T0 + 60_000 });
    expect(s).toMatchObject({ frames: 0, distance_m: null, params: [] });
  });
});

describe('seriesDelta', () => {
  it('measures a strip series inside the range only', () => {
    const t = [0, 1000, 2000, 3000, 4000];
    const v = [1, 5, null, 9, 100];
    expect(seriesDelta(t, v, { t0_ms: 1000, t1_ms: 3000 })).toEqual({
      start: 5,
      end: 9,
      delta: 4,
      min: 5,
      max: 9,
      samples: 2,
    });
    expect(seriesDelta(t, v, { t0_ms: 5000, t1_ms: 6000 })).toBeNull();
  });
});

describe('formatting', () => {
  it('wraps degrees', () => {
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(16)).toBe(16);
  });
  it('measures a great circle', () => {
    expect(Math.round(haversine(51, -2, 51.001, -2))).toBe(111);
  });
  it('formats distance, span, and deltas', () => {
    expect(fmtDistance(850)).toBe('850 m');
    expect(fmtDistance(12_400)).toBe('12.4 km · 6.7 NM');
    expect(fmtSpan(4500)).toBe('4.50 s');
    expect(fmtSpan(125_000)).toBe('2m 05s');
    expect(fmtSpan(3_725_000)).toBe('1h 02m 05s');
    expect(fmtDelta(123.4, 'ft')).toBe('+123 ft');
    expect(fmtDelta(-0.4211, 'g')).toBe('−0.42 g');
    expect(fmtDelta(0, '')).toBe('±0.00');
    expect(fmtNum(12_345.6)).toBe('12,346');
    expect(fmtNum(12.345)).toBe('12.3');
  });
});
