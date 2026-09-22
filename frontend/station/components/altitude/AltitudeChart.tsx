import { useCallback, useEffect, useMemo, useRef } from 'react';
import type uPlot from 'uplot';
import { msToS } from '../../api/time';
import type { FlightStateDto } from '../../api/types';
import { clock } from '../../playback/clock';
import { frameIndex, valueAt } from '../../playback/frames';
import { useSession } from '../../store/session';
import type { Theme } from '../../theme/theme';
import { UTC_TIME_AXIS, utcDate } from '../charts/axisTime';
import { chartTheme } from '../charts/colors';
import { currentEvents, currentSelection, dragEnd } from '../charts/dragEnd';
import {
  coveragePlugin,
  eventsPlugin,
  gapPlugin,
  hoverBinding,
  markerPlugin,
  seekBinding,
  selectionPlugin,
} from '../charts/plugins';
import { useReadout, type Sample } from '../charts/useReadout';
import { useSeek } from '../charts/useSeek';
import { useUPlot } from '../charts/useUPlot';
import { boundsOf, DRAG_DIST_PX } from '../charts/viewRange';
import { altitudeData } from './altitudeData';

/** The flight-state frame the instruments read, as a sample. */
function altSample(flight: FlightStateDto, i: number): Sample {
  return { t_ms: flight.t0_ms + i * flight.dt_ms, v: valueAt(flight.cols.alt, i) };
}

function buildOpts(
  flight: FlightStateDto,
  theme: Theme,
  onSeek: (t: number) => void,
  onHover: (idx: number | null) => void,
): uPlot.Options {
  const th = chartTheme(theme);
  const seek = seekBinding(onSeek);
  const segs = flight.segments.map((s) => ({ t0: s.t0_ms, t1: s.t1_ms }));
  const marks = flight.markers.map((m) => ({ t: m.t_ms, text: m.text }));
  const unit = flight.units.alt;
  return {
    width: 0,
    height: 0,
    title: '',
    cursor: {
      sync: { key: 'fts' },
      drag: { x: true, y: false, setScale: false, dist: DRAG_DIST_PX, click: seek.dragClick },
      points: { show: false },
      // Time series: the playhead and hover are vertical only.
      y: false,
    },
    legend: { show: false },
    scales: { x: { time: true } },
    tzDate: utcDate,
    axes: [
      {
        stroke: th.text,
        grid: { stroke: th.grid },
        ticks: { stroke: th.grid },
        values: UTC_TIME_AXIS,
        // 110 px: the widest label is ~100 px, so ticks never touch.
        space: 110,
      },
      {
        stroke: th.text,
        grid: { stroke: th.grid },
        ticks: { stroke: th.grid },
        label: unit ? `Altitude (${unit})` : 'Altitude',
        labelSize: 14,
      },
    ],
    series: [{}, { stroke: th.series[0], width: 1.5, spanGaps: false, points: { show: false } }],
    plugins: [
      gapPlugin(segs, th),
      coveragePlugin(() => clock.t, th),
      markerPlugin(marks, th),
      selectionPlugin(currentSelection, th),
      eventsPlugin(currentEvents, th),
      seek.plugin,
      hoverBinding(onHover),
    ],
    hooks: {
      setSelect: [(u) => dragEnd(u, seek.shiftHeld())],
    },
  };
}

interface ChartProps {
  flight: FlightStateDto;
  data: uPlot.AlignedData;
  onHover: (idx: number | null) => void;
}

function Chart({ flight, data, onHover }: ChartProps) {
  const theme = useSession((s) => s.theme);
  const view = useSession((s) => s.view);
  const selection = useSession((s) => s.selection);
  const events = useSession((s) => s.events);
  const dragMode = useSession((s) => s.dragMode);
  const resetZoom = useSession((s) => s.resetZoom);
  const seek = useSeek();
  const el = useRef<HTMLDivElement>(null);
  const chart = useUPlot(el, () => buildOpts(flight, theme, seek, onHover), data, [seek, onHover]);

  useEffect(() => {
    // The highlight and event plugins read the store; a change only needs a repaint.
    chart.current?.redraw(false, false);
  }, [chart, selection, events]);

  useEffect(() => {
    // The whole flight state is loaded: rescale, never refetch.
    const u = chart.current;
    if (!u) return;
    const win = view ?? boundsOf(flight);
    u.setScale('x', { min: msToS(win.t0_ms), max: msToS(win.t1_ms) });
  }, [chart, flight, view, data, theme]);

  useEffect(() => {
    // Drive the cursor and shading at frame rate, outside React.
    let lastPx = -1;
    return clock.subscribe((t) => {
      const u = chart.current;
      if (!u) return;
      const px = Math.round(u.valToPos(msToS(t), 'x'));
      if (px === lastPx) return;
      lastPx = px;
      u.setCursor({ left: px, top: 1 });
      u.redraw(false, false);
    });
  }, [chart, flight, theme]);

  return (
    <div ref={el} className={`absolute inset-0 pr-2 drag-${dragMode}`} onDoubleClick={resetZoom} />
  );
}

export default function AltitudeChart() {
  const flight = useSession((s) => s.flight);
  const data = useMemo(() => (flight ? altitudeData(flight) : null), [flight]);
  const atIndex = useCallback((i: number) => (flight ? altSample(flight, i) : null), [flight]);
  const atTime = useCallback(
    (t: number) =>
      flight ? altSample(flight, frameIndex(flight.t0_ms, flight.dt_ms, flight.n, t)) : null,
    [flight],
  );
  const { ref, onHover } = useReadout(atIndex, atTime, flight?.units.alt ?? '');

  if (!flight || !data) {
    return <div className="h-full grid place-items-center text-muted">No altitude data</div>;
  }
  return (
    <>
      <Chart flight={flight} data={data} onHover={onHover} />
      {/* Overlaid: a title-bar row would reflow the panel. */}
      <span
        ref={ref}
        className="readout whitespace-pre pointer-events-none absolute top-1 right-3 z-10 bg-surface px-1 rounded text-xs"
      />
    </>
  );
}
