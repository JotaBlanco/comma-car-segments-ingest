import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { fetchSeries } from '../../api/fts';
import type { SeriesDto } from '../../api/types';
import { log } from '../../log';
import { useSession, type PickedSignal } from '../../store/session';
import { needsLoad, type LoadedWindow, type ViewRange } from '../charts/viewRange';

const MIN_BUCKETS = 200;
const MAX_BUCKETS = 5000;
const DEBOUNCE_MS = 100;

export interface SeriesState {
  series: SeriesDto | null;
  error: string | null;
  /** A refetch is in flight; dim the line already drawn. */
  stale: boolean;
}

/** One M4 bucket per plot pixel, so the lake reduces to pixels. */
function bucketsFor(host: HTMLDivElement | null): number {
  return Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, host?.clientWidth ?? 0));
}

/** One signal's line; a zoom refetch is debounced. */
export function useSeries(
  pick: PickedSignal,
  win: ViewRange,
  host: RefObject<HTMLDivElement | null>,
): SeriesState {
  const aircraft = useSession((s) => s.aircraft);
  const recording = useSession((s) => s.recording);
  const [series, setSeries] = useState<SeriesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const loaded = useRef<LoadedWindow | null>(null);
  const { t0_ms: t0, t1_ms: t1 } = win;

  useEffect(() => {
    if (!aircraft || !recording || t1 <= t0) return;
    let alive = true;
    const delay = loaded.current === null ? 0 : DEBOUNCE_MS;
    const timer = setTimeout(() => {
      const buckets = bucketsFor(host.current);
      const next = { source: `${aircraft}/${recording}`, range: { t0_ms: t0, t1_ms: t1 } };
      if (!needsLoad(loaded.current, next, Math.ceil((t1 - t0) / buckets))) {
        setPending(false);
        return;
      }
      const q = { table: pick.table, scope: pick.scope, signal: pick.signal, t0, t1, buckets };
      setPending(true);
      fetchSeries(aircraft, recording, q)
        .then((s) => {
          if (!alive) return;
          // Commit the window only once its line is on screen.
          loaded.current = next;
          setSeries(s);
          setError(null);
          setPending(false);
          log.debug('strips', 'series loaded', {
            signal: pick.signal,
            buckets,
            points: s.t_ms.length,
            count: s.count,
          });
        })
        .catch((e: Error) => {
          if (!alive) return;
          setError(e.message);
          setPending(false);
          log.warn('strips', 'series load failed', { ...q, error: e.message });
        });
    }, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [aircraft, recording, pick, host, t0, t1]);

  return useMemo(
    () => ({ series, error, stale: pending && series !== null }),
    [series, error, pending],
  );
}
