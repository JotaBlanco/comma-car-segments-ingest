import type uPlot from 'uplot';
import { msToS } from '../../api/time';
import type { FlightStateDto } from '../../api/types';

/** x in seconds plus the altitude column, or null if empty. */
export function altitudeData(flight: FlightStateDto): uPlot.AlignedData | null {
  // alt can be missing at runtime despite the type.
  const alt = flight.cols.alt;
  if (flight.segments.length === 0 || !alt) return null;
  if (!alt.some((v) => v !== null)) return null;
  const xs = new Float64Array(flight.n);
  for (let i = 0; i < flight.n; i++) xs[i] = msToS(flight.t0_ms + i * flight.dt_ms);
  return [xs, alt];
}
