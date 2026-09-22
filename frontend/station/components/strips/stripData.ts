import type uPlot from 'uplot';
import { msToS } from '../../api/time';
import type { SeriesDto } from '../../api/types';

/** Sample times in seconds plus one value column; null is a gap. */
export function stripData(series: SeriesDto): uPlot.AlignedData | null {
  if (series.t_ms.length === 0) return null;
  return [series.t_ms.map(msToS), series.v];
}
