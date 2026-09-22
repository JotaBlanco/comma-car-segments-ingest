import { useEffect, useRef, type RefObject } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { log } from '../../log';
import { useSession } from '../../store/session';

/** Owns one uPlot; a theme flip rebuilds it — dep on theme. */
export function useUPlot(
  el: RefObject<HTMLDivElement | null>,
  makeOpts: () => uPlot.Options,
  data: uPlot.AlignedData | null,
  deps: unknown[],
): RefObject<uPlot | null> {
  const chart = useRef<uPlot | null>(null);
  const theme = useSession((s) => s.theme);
  useEffect(() => {
    const host = el.current;
    if (!host || !data) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    // A hidden host measures 0; create 1x1, the observer fixes it.
    if (w === 0 || h === 0) log.warn('chart', 'host has no size yet', { w, h });
    const opts = makeOpts();
    opts.width = Math.max(w, 1);
    opts.height = Math.max(h, 1);
    const u = new uPlot(opts, data, host);
    chart.current = u;
    log.debug('chart', 'created', { width: opts.width, height: opts.height, series: data.length });
    const ro = new ResizeObserver(() =>
      u.setSize({
        width: Math.max(host.clientWidth, 1),
        height: Math.max(host.clientHeight, 1),
      }),
    );
    ro.observe(host);
    return () => {
      ro.disconnect();
      u.destroy();
      chart.current = null;
      log.debug('chart', 'destroyed');
    };
    // deps is the caller's explicit list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, data, theme, ...deps]);
  return chart;
}
