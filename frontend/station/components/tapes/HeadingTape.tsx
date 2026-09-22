import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clock } from '../../playback/clock';
import { frameIndex, valueAt } from '../../playback/frames';
import { makeThrottle } from '../../playback/throttle';
import { useSession } from '../../store/session';
import {
  headingPxPerDeg,
  headingRuler,
  labelVisible,
  restValue,
  wrapHeading,
  type LabelBand,
} from './scale';

const H = 56;
const BOX_W = 68;
const BOX_H = 24;
const NOSE = 5; // depth of the pointer triangle aimed at the ruler
const SIDE = BOX_W / 2 - NOSE; // flat run either side of the nose
// Labels this close to the box centre are clipped away.
const HIDE_X = BOX_W / 2 + 3;
const TICK_TOP = 32; // the ruler starts below the box nose
const EDGE = 8; // inset so no label is cut by the strip's own end
const LABEL_HALF = 11; // half a 3-digit label's width at font-size 12

function band(w: number): LabelBand {
  return { boxCentre: w / 2, hideHalf: HIDE_X, edge: EDGE, len: w, half: LABEL_HALF };
}

// Rect with a nose pointing down at the ruler, centred on `cx`.
function boxPath(cx: number): string {
  return (
    `M${cx - BOX_W / 2} 2 h${BOX_W} v${BOX_H} h-${SIDE} ` +
    `l-${NOSE} ${NOSE} l-${NOSE} -${NOSE} h-${SIDE} z`
  );
}

function cardinal(d: number): string {
  if (d === 0) return 'N';
  if (d === 90) return 'E';
  if (d === 180) return 'S';
  if (d === 270) return 'W';
  return String(d);
}

/** Heading ruler: 1 SVG unit = 1 px, fixed 120° visible span. */
export default function HeadingTape() {
  const flight = useSession((s) => s.flight);
  const host = useRef<HTMLDivElement>(null);
  const g = useRef<SVGGElement>(null);
  const txt = useRef<SVGTextElement>(null);
  const [w, setW] = useState(0);
  const marks = useMemo(() => headingRuler(w), [w]);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!flight) return;
    const gate = makeThrottle(83);
    const pxPerDeg = headingPxPerDeg(w);
    const labels = g.current?.querySelectorAll<SVGTextElement>('text[data-v]') ?? [];
    const shownNow = new Uint8Array(labels.length).fill(2);
    const zone = band(w);
    return clock.subscribe((t) => {
      const i = frameIndex(flight.t0_ms, flight.dt_ms, flight.n, t);
      const raw = valueAt(flight.cols.hdg, i);
      const hdg = wrapHeading(restValue(raw));
      g.current?.setAttribute('transform', `translate(${-hdg * pxPerDeg} 0)`);
      labels.forEach((el, k) => {
        const x = Number(el.dataset.v) - hdg * pxPerDeg;
        const on = labelVisible(x, zone) ? 1 : 0;
        if (shownNow[k] === on) return;
        shownNow[k] = on;
        el.style.opacity = on ? '1' : '0';
      });
      if (txt.current && gate()) {
        const deg = Math.round(hdg) % 360;
        txt.current.textContent = raw === null ? '---' : `${String(deg).padStart(3, '0')}°`;
      }
    });
    // Resubscribe on resize so the scale never goes stale.
  }, [flight, w]);

  return (
    <div ref={host} className="hdg-tape">
      {w > 0 && (
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`}>
          <defs>
            <clipPath id="hdg-clip" clipPathUnits="userSpaceOnUse">
              <rect x="0" y="0" width={Math.max(w / 2 - HIDE_X, 0)} height={H} />
              <rect x={w / 2 + HIDE_X} y="0" width={Math.max(w / 2 - HIDE_X, 0)} height={H} />
              <rect x={w / 2 - HIDE_X} y={TICK_TOP} width={HIDE_X * 2} height={H - TICK_TOP} />
            </clipPath>
          </defs>
          <rect x="0" y="0" width={w} height={H} className="svg-fill-surface-2" />
          <g clipPath="url(#hdg-clip)">
            <g ref={g}>
              {marks.map((m) => (
                <g key={m.key}>
                  <line
                    x1={m.x}
                    y1="46"
                    x2={m.x}
                    y2={m.d % 30 === 0 ? 34 : 40}
                    className="svg-stroke-muted"
                  />
                  {m.d % 30 === 0 && (
                    <text
                      x={m.x}
                      y="30"
                      data-v={m.x}
                      textAnchor="middle"
                      fontSize="12"
                      className="svg-fill-text"
                    >
                      {cardinal(m.d)}
                    </text>
                  )}
                </g>
              ))}
            </g>
          </g>
          <polygon
            points={`${w / 2},48 ${w / 2 - 6},56 ${w / 2 + 6},56`}
            className="svg-fill-warn"
          />
          <path d={boxPath(w / 2)} className="svg-fill-surface svg-stroke-accent" />
          <text
            ref={txt}
            x={w / 2}
            y="19"
            textAnchor="middle"
            fontSize="16"
            className="readout svg-fill-text"
          />
        </svg>
      )}
    </div>
  );
}
