import { describe, expect, it } from 'vitest';
import type { FlightStateDto } from '../api/types';
import { frameIndex, valueAt } from './frames';
import { segmentIndex } from './gaps';
import fixture from './__fixtures__/flightstate.json';

describe('frames', () => {
  it('rounds to the nearest grid frame and clamps', () => {
    expect(frameIndex(1000, 100, 11, 1000)).toBe(0);
    expect(frameIndex(1000, 100, 11, 1049)).toBe(0);
    expect(frameIndex(1000, 100, 11, 1051)).toBe(1);
    expect(frameIndex(1000, 100, 11, 99999)).toBe(10);
    expect(frameIndex(1000, 100, 11, 0)).toBe(0);
  });
  it('valueAt returns null for missing', () => {
    expect(valueAt([1, null, 3], 1)).toBeNull();
    expect(valueAt([1, null, 3], 2)).toBe(3);
  });
});

// The fixture carries a `_note` key the DTO has no field for, hence the cast.
const flight = fixture as unknown as FlightStateDto;
const segments = flight.segments.map((s) => ({ t0: s.t0_ms, t1: s.t1_ms }));

describe('frames × segments contract', () => {
  it('reads null for a time inside the gap, not a neighbouring value', () => {
    const idx = frameIndex(flight.t0_ms, flight.dt_ms, flight.n, 4000);
    expect(valueAt(flight.cols.pitch, idx)).toBeNull();
  });

  it('clamps a time past the last segment end to the last frame', () => {
    const idx = frameIndex(flight.t0_ms, flight.dt_ms, flight.n, 99_999);
    expect(idx).toBe(flight.n - 1);
    expect(valueAt(flight.cols.pitch, idx)).not.toBeNull();
  });

  it('clamps a time before the first segment start to frame 0', () => {
    expect(frameIndex(flight.t0_ms, flight.dt_ms, flight.n, 0)).toBe(0);
  });

  it('has a value on exactly the frames that fall inside a segment', () => {
    for (let i = 0; i < flight.n; i++) {
      const t = flight.t0_ms + i * flight.dt_ms;
      expect({ i, hasValue: valueAt(flight.cols.pitch, i) !== null }).toEqual({
        i,
        hasValue: segmentIndex(segments, t) >= 0,
      });
    }
  });
});
