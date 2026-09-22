import { describe, expect, it } from 'vitest';
import type { ColName, FlightStateDto } from '../../api/types';
import { altitudeData } from './altitudeData';

const COLS: ColName[] = [
  'lat',
  'lon',
  'alt',
  'pitch',
  'roll',
  'hdg',
  'gs',
  'cas',
  'tas',
  'vs',
  'phase',
  'fcs',
];

function fill<T>(value: () => T): Record<ColName, T> {
  return Object.fromEntries(COLS.map((c) => [c, value()])) as Record<ColName, T>;
}

function makeFlight(over: Partial<FlightStateDto> = {}): FlightStateDto {
  return {
    t0_ms: 1000,
    dt_ms: 500,
    n: 3,
    segments: [{ t0_ms: 1000, t1_ms: 2000, chunk_seq: 0 }],
    markers: [],
    cols: { ...fill<(number | null)[]>(() => []), alt: [500, 510, null] },
    units: fill(() => ''),
    source: fill(() => ''),
    texts: {},
    ...over,
  };
}

describe('altitudeData', () => {
  it('is null when the recording has no coverage segments', () => {
    expect(altitudeData(makeFlight({ segments: [] }))).toBeNull();
  });

  it('is null when the payload carries no altitude column', () => {
    const flight = makeFlight();
    delete (flight.cols as Partial<Record<ColName, (number | null)[]>>).alt;
    expect(altitudeData(flight)).toBeNull();
  });

  it('is null when every altitude sample is null', () => {
    expect(
      altitudeData(
        makeFlight({ cols: { ...fill<(number | null)[]>(() => []), alt: [null, null, null] } }),
      ),
    ).toBeNull();
  });

  it('builds x values in seconds from t0_ms, dt_ms and n', () => {
    const data = altitudeData(makeFlight());
    if (data === null) throw new Error('expected altitude data');
    expect(Array.from(data[0])).toEqual([1, 1.5, 2]);
  });

  it('passes the altitude column through by reference', () => {
    const flight = makeFlight();
    const data = altitudeData(flight);
    if (data === null) throw new Error('expected altitude data');
    expect(data[1]).toBe(flight.cols.alt);
  });
});
