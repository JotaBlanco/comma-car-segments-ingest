import { useEffect, useMemo, useRef } from 'react';
import type { ColName } from '../../api/types';
import { clock } from '../../playback/clock';
import { frameIndex, valueAt } from '../../playback/frames';
import { makeThrottle } from '../../playback/throttle';
import { useSession } from '../../store/session';
import { formatSample, labelVisible, restValue, tapeTicks } from './scale';

interface Props {
  col: ColName;
  label: string;
  min: number;
  max: number;
  step: number;
  span: number; // units visible across the tape height
  decimals?: number;
}

const H = 200;
const W = 64;
const TOP = 26; // label plus unit band above the ruler
const BOX_H = 22;
const BOX_X = 2;
const NOSE = 5; // depth of the pointer triangle on the scale side
const BOX_W = W - BOX_X - NOSE;
// Ticks this close to the box centre are clipped away.
const HIDE_Y = BOX_H / 2 + 3;
// Inset so no label is cut in half by the tape's own edge.
const EDGE = 8;
const BAND = {
  boxCentre: H / 2 - TOP,
  hideHalf: HIDE_Y,
  edge: EDGE,
  len: H - TOP,
  half: 4, // half the glyph height at font-size 10
};

// Rect with a nose pointing right at the tick column.
const BOX =
  `M${BOX_X} ${H / 2 - BOX_H / 2} h${BOX_W} ` +
  `l${NOSE} ${BOX_H / 2} l-${NOSE} ${BOX_H / 2} h-${BOX_W} z`;

/** Vertical tape: ticks translate, the readout box is fixed. */
export default function Tape({ col, label, min, max, step, span, decimals = 0 }: Props) {
  const flight = useSession((s) => s.flight);
  const ticks = useMemo(() => tapeTicks(min, max, step), [min, max, step]);
  const pxPerUnit = H / span;
  const g = useRef<SVGGElement>(null);
  const txt = useRef<SVGTextElement>(null);

  useEffect(() => {
    if (!flight) return;
    const gate = makeThrottle(83);
    const labels = g.current?.querySelectorAll<SVGTextElement>('text[data-v]') ?? [];
    const shownNow = new Uint8Array(labels.length).fill(2);
    return clock.subscribe((t) => {
      const i = frameIndex(flight.t0_ms, flight.dt_ms, flight.n, t);
      const v = valueAt(flight.cols[col], i);
      const shown = restValue(v);
      g.current?.setAttribute('transform', `translate(0 ${shown * pxPerUnit})`);
      labels.forEach((el, k) => {
        const y = Number(el.dataset.v) + shown * pxPerUnit - TOP;
        const on = labelVisible(y, BAND) ? 1 : 0;
        if (shownNow[k] === on) return;
        shownNow[k] = on;
        el.style.opacity = on ? '1' : '0';
      });
      if (txt.current && gate()) {
        txt.current.textContent = formatSample(v, decimals);
      }
    });
  }, [flight, col, decimals, pxPerUnit, ticks]);

  const unit = flight?.units[col] ?? '';
  const clipId = `tape-clip-${col}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full">
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <rect x="0" y={TOP + EDGE} width={W} height={H / 2 - HIDE_Y - TOP - EDGE} />
          <rect x="0" y={H / 2 + HIDE_Y} width={W} height={H / 2 - HIDE_Y - EDGE} />
        </clipPath>
      </defs>
      <text x={W / 2} y="11" textAnchor="middle" fontSize="10" className="svg-fill-text">
        {label}
      </text>
      {unit && (
        <text x={W / 2} y="22" textAnchor="middle" fontSize="9" className="svg-fill-muted">
          ({unit})
        </text>
      )}
      <rect x="0" y={TOP} width={W} height={H - TOP} className="svg-fill-surface-2" />
      <g clipPath={`url(#${clipId})`}>
        <g ref={g}>
          {ticks.map((v) => {
            const y = H / 2 - v * pxPerUnit;
            return (
              <g key={v}>
                <line x1="44" y1={y} x2="56" y2={y} className="svg-stroke-muted" />
                <text
                  x="40"
                  y={y + 3}
                  data-v={y}
                  textAnchor="end"
                  fontSize="10"
                  className="svg-fill-text"
                >
                  {v}
                </text>
              </g>
            );
          })}
        </g>
      </g>
      <path d={BOX} className="svg-fill-surface svg-stroke-accent" />
      <text
        ref={txt}
        x={BOX_X + BOX_W / 2}
        y={H / 2 + 5}
        textAnchor="middle"
        fontSize="13"
        className="readout svg-fill-text"
      />
    </svg>
  );
}
