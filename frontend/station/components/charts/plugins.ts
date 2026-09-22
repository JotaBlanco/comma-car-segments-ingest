import type uPlot from 'uplot';
import { msToS, sToMs } from '../../api/time';
import { log } from '../../log';
import type { Segment } from '../../playback/gaps';
import { type ChartTheme, withAlpha } from './colors';
import { DRAG_DIST_PX, isClick } from './viewRange';

export interface Marker {
  t: number;
  text: string;
}

/** Spans between coverage segments, in uPlot x seconds. */
export function gapRanges(segments: Segment[]): { t0: number; t1: number }[] {
  const out: { t0: number; t1: number }[] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push({ t0: msToS(segments[i - 1].t1), t1: msToS(segments[i].t0) });
  }
  return out;
}

function fillX(u: uPlot, x0: number, x1: number, color: string): void {
  const { ctx, bbox } = u;
  const left = Math.max(bbox.left, u.valToPos(x0, 'x', true));
  const right = Math.min(bbox.left + bbox.width, u.valToPos(x1, 'x', true));
  if (right <= left) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(left, bbox.top, right - left, bbox.height);
  ctx.restore();
}

const FLOWN_ALPHA = 0.15;
const SELECT_ALPHA = 0.13;

/** A time range in ms, as the charts share it. */
export interface Range {
  t0_ms: number;
  t1_ms: number;
}

export interface EventBand {
  label: string;
  t0_ms: number;
  t1_ms: number;
  instant: boolean;
}

const EVENT_ALPHA = 0.14;
const EVENT_MIN_PX = 3;

/** Draws every picked snippet as a band over its period (an instant as a thin bar), labelled
 *  along the top; the labels step down when neighbours would overlap. */
export function eventsPlugin(getEvents: () => EventBand[], colors: ChartTheme): uPlot.Plugin {
  const fill = withAlpha(colors.alarm, EVENT_ALPHA);
  return {
    hooks: {
      draw: (u) => {
        const events = getEvents();
        if (events.length === 0) return;
        const { ctx, bbox } = u;
        const right = bbox.left + bbox.width;
        ctx.save();
        ctx.font = '10px sans-serif';
        let lastLabelEnd = -Infinity;
        let row = 0;
        for (const e of events) {
          const x0 = u.valToPos(msToS(e.t0_ms), 'x', true);
          const x1 = u.valToPos(msToS(e.t1_ms), 'x', true);
          const a = Math.max(bbox.left, Math.min(x0, x1));
          const b = Math.min(right, Math.max(x0, x1, x0 + EVENT_MIN_PX));
          if (b <= bbox.left || a >= right) continue;
          ctx.fillStyle = e.instant ? colors.alarm : fill;
          ctx.fillRect(a, bbox.top, Math.max(EVENT_MIN_PX, b - a), bbox.height);
          if (!e.instant) {
            ctx.strokeStyle = colors.alarm;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a, bbox.top);
            ctx.lineTo(a, bbox.top + bbox.height);
            ctx.moveTo(b, bbox.top);
            ctx.lineTo(b, bbox.top + bbox.height);
            ctx.stroke();
          }
          const tx = Math.max(bbox.left + 2, a + 3);
          row = tx < lastLabelEnd ? (row + 1) % 3 : 0;
          const ty = bbox.top + 10 + row * 12;
          ctx.fillStyle = colors.alarm;
          ctx.fillText(e.label, tx, ty);
          lastLabelEnd = tx + ctx.measureText(e.label).width + 8;
        }
        ctx.restore();
      },
    },
  };
}

/** Highlights the marked period on top of the line: a tint with two edges. */
export function selectionPlugin(getRange: () => Range | null, colors: ChartTheme): uPlot.Plugin {
  const fill = withAlpha(colors.select, SELECT_ALPHA);
  return {
    hooks: {
      draw: (u) => {
        const r = getRange();
        if (!r) return;
        const { ctx, bbox } = u;
        const x0 = u.valToPos(msToS(r.t0_ms), 'x', true);
        const x1 = u.valToPos(msToS(r.t1_ms), 'x', true);
        const left = Math.max(bbox.left, Math.min(x0, x1));
        const right = Math.min(bbox.left + bbox.width, Math.max(x0, x1));
        if (right <= left) return;
        ctx.save();
        ctx.fillStyle = fill;
        ctx.fillRect(left, bbox.top, right - left, bbox.height);
        ctx.strokeStyle = colors.select;
        ctx.lineWidth = 1;
        for (const x of [x0, x1]) {
          if (x < bbox.left || x > bbox.left + bbox.width) continue;
          ctx.beginPath();
          ctx.moveTo(x, bbox.top);
          ctx.lineTo(x, bbox.top + bbox.height);
          ctx.stroke();
        }
        ctx.restore();
      },
    },
  };
}

/** Shades everything before the cursor: covered vs ahead. */
export function coveragePlugin(getT: () => number, colors: ChartTheme): uPlot.Plugin {
  const fill = withAlpha(colors.flown, FLOWN_ALPHA);
  return {
    hooks: {
      drawClear: (u) => {
        const xMin = u.scales.x.min ?? 0;
        fillX(u, xMin, msToS(getT()), fill);
      },
    },
  };
}

export function gapPlugin(segments: Segment[], colors: ChartTheme): uPlot.Plugin {
  const gaps = gapRanges(segments);
  return {
    hooks: {
      drawClear: (u) => {
        for (const g of gaps) fillX(u, g.t0, g.t1, colors.gap);
      },
    },
  };
}

export function markerPlugin(markers: Marker[], colors: ChartTheme): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const { ctx, bbox } = u;
        ctx.save();
        ctx.strokeStyle = colors.warn;
        ctx.fillStyle = colors.warn;
        ctx.font = '10px sans-serif';
        for (const m of markers) {
          const x = u.valToPos(msToS(m.t), 'x', true);
          if (x < bbox.left || x > bbox.left + bbox.width) continue;
          ctx.beginPath();
          ctx.moveTo(x, bbox.top);
          ctx.lineTo(x, bbox.top + bbox.height);
          ctx.stroke();
          ctx.fillText(m.text, x + 3, bbox.top + 10);
        }
        ctx.restore();
      },
    },
  };
}

// One shared flag: every synced chart follows the hovered one.
let hovering = false;

/** Reports the sample under the mouse, null once it leaves. */
export function hoverBinding(onHover: (idx: number | null) => void): uPlot.Plugin {
  return {
    hooks: {
      init: (u) => {
        u.over.addEventListener('mouseenter', () => {
          hovering = true;
        });
        u.over.addEventListener('mouseleave', () => {
          hovering = false;
          onHover(null);
        });
      },
      setCursor: (u) => onHover(hovering ? (u.cursor.idx ?? null) : null),
    },
  };
}

export interface SeekBinding {
  plugin: uPlot.Plugin;
  dragClick: (self: uPlot, e: MouseEvent) => void;
  /** Whether shift was down when the current drag began. */
  shiftHeld: () => boolean;
}

/** A click seeks; a drag past the threshold is a zoom or a selection instead. */
export function seekBinding(onSeek: (t: number) => void): SeekBinding {
  let downX = 0;
  let shift = false;
  const clicked = (e: MouseEvent) => isClick(e.clientX - downX, DRAG_DIST_PX);
  return {
    shiftHeld: () => shift,
    plugin: {
      hooks: {
        init: (u) => {
          u.over.addEventListener('mousedown', (e) => {
            downX = e.clientX;
            shift = e.shiftKey;
          });
          u.over.addEventListener('click', (e) => {
            if (!clicked(e)) return;
            const x = e.clientX - u.over.getBoundingClientRect().left;
            const t = sToMs(u.posToVal(x, 'x'));
            log.debug('chart', 'click seek', { t });
            onSeek(t);
          });
        },
      },
    },
    // uPlot swallows any click that moved a pixel; only kill a drag.
    dragClick: (_u, e) => {
      if (clicked(e)) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
    },
  };
}
