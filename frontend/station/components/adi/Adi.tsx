import { useEffect, useRef } from 'react';
import { clock } from '../../playback/clock';
import { frameIndex, valueAt } from '../../playback/frames';
import { makeThrottle } from '../../playback/throttle';
import { useSession } from '../../store/session';

const PX_PER_DEG = 4; // pitch ladder scale inside a 200x200 viewBox
const LADDER = [-30, -20, -10, 10, 20, 30];
const ROLL_MARKS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];

/** Attitude indicator: roll rotates, pitch translates. */
export default function Adi() {
  const flight = useSession((s) => s.flight);
  const rollRef = useRef<SVGGElement>(null);
  const pitchRef = useRef<SVGGElement>(null);
  const readout = useRef<SVGTextElement>(null);

  useEffect(() => {
    if (!flight) return;
    const gate = makeThrottle(83);
    return clock.subscribe((t) => {
      const i = frameIndex(flight.t0_ms, flight.dt_ms, flight.n, t);
      const rawPitch = valueAt(flight.cols.pitch, i);
      const rawRoll = valueAt(flight.cols.roll, i);
      const pitch = rawPitch ?? 0;
      const roll = rawRoll ?? 0;
      rollRef.current?.setAttribute('transform', `rotate(${-roll} 100 100)`);
      pitchRef.current?.setAttribute('transform', `translate(0 ${pitch * PX_PER_DEG})`);
      if (readout.current && gate()) {
        const gap = rawPitch === null || rawRoll === null;
        readout.current.textContent = gap ? '---' : `P ${pitch.toFixed(1)}°  R ${roll.toFixed(1)}°`;
      }
    });
  }, [flight]);

  return (
    <svg viewBox="0 0 200 200" className="h-full w-full">
      <defs>
        <clipPath id="adi-clip" clipPathUnits="userSpaceOnUse">
          <circle cx="100" cy="100" r="88" />
        </clipPath>
      </defs>
      <g clipPath="url(#adi-clip)">
        <g ref={rollRef}>
          <g ref={pitchRef}>
            <rect x="-200" y="-400" width="600" height="500" className="svg-fill-sky" />
            <rect x="-200" y="100" width="600" height="500" className="svg-fill-ground" />
            <line x1="-200" y1="100" x2="400" y2="100" stroke="#fff" strokeWidth="1.5" />
            {LADDER.map((d) => (
              <g key={d}>
                <line
                  x1={100 - (Math.abs(d) % 20 === 0 ? 24 : 14)}
                  y1={100 - d * PX_PER_DEG}
                  x2={100 + (Math.abs(d) % 20 === 0 ? 24 : 14)}
                  y2={100 - d * PX_PER_DEG}
                  stroke="#fff"
                  strokeWidth="1"
                />
                <text x={130} y={100 - d * PX_PER_DEG + 3} fill="#fff" fontSize="8">
                  {Math.abs(d)}
                </text>
              </g>
            ))}
          </g>
          {ROLL_MARKS.map((a) => (
            <line
              key={a}
              x1="100"
              y1="14"
              x2="100"
              y2={a % 30 === 0 ? 24 : 20}
              stroke="#fff"
              strokeWidth={a === 0 ? 2 : 1}
              transform={`rotate(${a} 100 100)`}
            />
          ))}
        </g>
      </g>
      <polygon points="100,16 96,24 104,24" className="svg-fill-warn" />
      <path
        d="M60 100 L85 100 L92 107 L100 100 L108 107 L115 100 L140 100"
        className="svg-stroke-warn"
        strokeWidth="3"
        fill="none"
      />
      <circle cx="100" cy="100" r="88" fill="none" className="svg-stroke-border" strokeWidth="2" />
      <text
        ref={readout}
        x="100"
        y="194"
        textAnchor="middle"
        fontSize="9"
        className="readout svg-fill-text"
      />
    </svg>
  );
}
