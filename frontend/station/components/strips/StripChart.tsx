import { useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type uPlot from 'uplot';
import { msToS } from '../../api/time';
import type { FlightStateDto, SeriesDto } from '../../api/types';
import { clock } from '../../playback/clock';
import { fmtDelta, fmtNum, seriesDelta } from '../../selection/summary';
import { useSession, type PickedSignal } from '../../store/session';
import type { Theme } from '../../theme/theme';
import { UTC_TIME_AXIS, utcDate } from '../charts/axisTime';
import { chartTheme } from '../charts/colors';
import { currentEvents, currentSelection, dragEnd } from '../charts/dragEnd';
import {
  coveragePlugin,
  eventsPlugin,
  gapPlugin,
  hoverBinding,
  seekBinding,
  selectionPlugin,
} from '../charts/plugins';
import { useReadout, type Sample } from '../charts/useReadout';
import { useSeek } from '../charts/useSeek';
import { indexAtOrBefore } from '../charts/valueReadout';
import { useUPlot } from '../charts/useUPlot';
import { boundsOf, DRAG_DIST_PX, type ViewRange } from '../charts/viewRange';
import { fmtRange, seriesRange } from './readout';
import { stripData } from './stripData';
import { useSeries } from './useSeries';

/** One loaded sample, or null when the index is off the line. */
function sampleAt(series: SeriesDto | null, i: number): Sample | null {
  if (!series || i < 0 || i >= series.t_ms.length) return null;
  return { t_ms: series.t_ms[i], v: series.v[i] };
}

interface StripProps {
  pick: PickedSignal;
  index: number;
  /** What the cross does; the ad hoc list unticks the tree, a waveform drops its own entry. */
  onRemove?: (pick: PickedSignal) => void;
}

interface StripOpts {
  flight: FlightStateDto;
  theme: Theme;
  index: number;
  unit: string;
  onSeek: (t: number) => void;
  onHover: (idx: number | null) => void;
}

function buildOpts({ flight, theme, index, unit, onSeek, onHover }: StripOpts): uPlot.Options {
  const th = chartTheme(theme);
  const seek = seekBinding(onSeek);
  const color = th.series[index % th.series.length];
  const segs = flight.segments.map((s) => ({ t0: s.t0_ms, t1: s.t1_ms }));
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
        label: unit,
        labelSize: 14,
        size: 52,
        // Tight tick spacing: a 220px strip should show several.
        space: 24,
      },
    ],
    series: [
      {},
      // Auto-shown: a marker means raw samples 40 px or more apart.
      { stroke: color, width: 1.25, spanGaps: false, points: { size: 4, space: 40 } },
    ],
    plugins: [
      gapPlugin(segs, th),
      coveragePlugin(() => clock.t, th),
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

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6 18 18M18 6 6 18" />
    </svg>
  );
}

function Frame({
  pick,
  index,
  note,
  alarm,
  selected,
  valueRef,
  onRemove,
  children,
}: {
  pick: PickedSignal;
  /** Pick order: the strip and its tree checkbox share the series colour. */
  index: number;
  onRemove?: (pick: PickedSignal) => void;
  note?: string;
  alarm?: boolean;
  /** What the series did across the marked period. */
  selected?: string;
  valueRef?: RefObject<HTMLSpanElement | null>;
  children: ReactNode;
}) {
  const togglePick = useSession((s) => s.togglePick);
  const remove = onRemove ?? togglePick;
  return (
    <section className="panel strip">
      <div className="panel-title strip-head">
        <span className="flex-1 min-w-0 truncate">
          <span
            className="strip-swatch"
            style={{ background: `var(--chart-s${(index % 8) + 1})` }}
            aria-hidden="true"
          />
          {pick.signal}
          <span className="readout normal-case tracking-normal">
            {' '}
            · {pick.table} {pick.scope}
          </span>
        </span>
        {valueRef && (
          <span
            ref={valueRef}
            className="readout normal-case tracking-normal whitespace-pre shrink-0 text-text"
          />
        )}
        {selected && (
          <span
            className="readout normal-case tracking-normal shrink-0 strip-selected"
            title="Across the selected period"
          >
            {selected}
          </span>
        )}
        {note && (
          <span
            className={`readout normal-case tracking-normal shrink-0 ${
              alarm ? 'text-alarm' : 'text-muted'
            }`}
          >
            {note}
          </span>
        )}
        <button
          type="button"
          className="icon-btn strip-remove"
          onClick={() => remove(pick)}
          title={`Remove ${pick.signal}`}
          aria-label={`Remove ${pick.signal}`}
        >
          <CloseIcon />
        </button>
      </div>
      {children}
    </section>
  );
}

function Note({ text, alarm }: { text: string; alarm?: boolean }) {
  const tone = alarm ? 'text-alarm' : 'text-muted';
  return <div className={`h-full grid place-items-center text-xs ${tone}`}>{text}</div>;
}

function Body({
  flight,
  series,
  data,
  error,
  index,
  win,
  onHover,
}: {
  flight: FlightStateDto;
  series: SeriesDto | null;
  data: uPlot.AlignedData | null;
  error: string | null;
  index: number;
  win: ViewRange;
  onHover: (idx: number | null) => void;
}) {
  // Dim, do not blank: a failed refetch keeps the drawn line.
  if (series && data) {
    return (
      <Plot
        flight={flight}
        data={data}
        index={index}
        unit={series.unit}
        win={win}
        onHover={onHover}
      />
    );
  }
  if (error) return <Note text={error} alarm />;
  if (!series) return <Note text="loading…" />;
  return <Note text="no samples" />;
}

function Plot({
  flight,
  data,
  index,
  unit,
  win,
  onHover,
}: {
  flight: FlightStateDto;
  data: uPlot.AlignedData;
  index: number;
  unit: string;
  win: ViewRange;
  onHover: (idx: number | null) => void;
}) {
  const theme = useSession((s) => s.theme);
  const selection = useSession((s) => s.selection);
  const events = useSession((s) => s.events);
  const dragMode = useSession((s) => s.dragMode);
  const seek = useSeek();
  const el = useRef<HTMLDivElement>(null);
  const chart = useUPlot(
    el,
    () => buildOpts({ flight, theme, index, unit, onSeek: seek, onHover }),
    data,
    [index, unit, seek, onHover],
  );

  useEffect(() => {
    // The highlight and event plugins read the store; a change only needs a repaint.
    chart.current?.redraw(false, false);
  }, [chart, selection, events]);

  useEffect(() => {
    // Pin x to the window so every synced chart shares one scale.
    const u = chart.current;
    if (!u) return;
    u.setScale('x', { min: msToS(win.t0_ms), max: msToS(win.t1_ms) });
  }, [chart, win.t0_ms, win.t1_ms, data, theme]);

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
  }, [chart, data, theme]);

  return <div ref={el} className={`absolute inset-0 drag-${dragMode}`} />;
}

export default function StripChart({ pick, index, onRemove }: StripProps) {
  const flight = useSession((s) => s.flight);
  const view = useSession((s) => s.view);
  const selection = useSession((s) => s.selection);
  const resetZoom = useSession((s) => s.resetZoom);
  const host = useRef<HTMLDivElement>(null);
  const bounds = boundsOf(flight);
  const win = view ?? bounds;
  const { series, error, stale } = useSeries(pick, win, host);
  const data = useMemo(() => (series ? stripData(series) : null), [series]);
  const range = useMemo(
    () => (series ? fmtRange(seriesRange(series.v), series.unit) : ''),
    [series],
  );
  const selected = useMemo(() => {
    if (!series || !selection) return undefined;
    const d = seriesDelta(series.t_ms, series.v, selection);
    if (!d) return undefined;
    const u = series.unit;
    return `Δ ${fmtDelta(d.delta, u)} · ${fmtNum(d.min)}…${fmtNum(d.max)}`;
  }, [series, selection]);
  const atIndex = useCallback((i: number) => sampleAt(series, i), [series]);
  const atTime = useCallback(
    (t: number) => {
      if (!series || t < win.t0_ms || t > win.t1_ms) return null;
      return sampleAt(series, indexAtOrBefore(series.t_ms, t));
    },
    [series, win.t0_ms, win.t1_ms],
  );
  const readout = useReadout(atIndex, atTime, series?.unit ?? '');

  if (!flight || bounds.t1_ms <= bounds.t0_ms) {
    return (
      <Frame pick={pick} index={index} onRemove={onRemove}>
        <div className="strip-body">
          <Note text="no recorded segments" />
        </div>
      </Frame>
    );
  }
  return (
    <Frame
      pick={pick}
      index={index}
      onRemove={onRemove}
      note={error ?? range}
      alarm={error !== null}
      selected={selected}
      valueRef={readout.ref}
    >
      <div
        ref={host}
        className={`strip-body ${stale ? 'strip-stale' : ''}`}
        onDoubleClick={resetZoom}
      >
        <Body
          flight={flight}
          series={series}
          data={data}
          error={error}
          index={index}
          win={win}
          onHover={readout.onHover}
        />
      </div>
    </Frame>
  );
}
