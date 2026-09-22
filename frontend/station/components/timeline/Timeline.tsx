import { useEffect, useRef, useState } from 'react';
import type { SegmentDto } from '../../api/types';
import { log } from '../../log';
import { clock } from '../../playback/clock';
import { fmtEventSpan } from '../../selection/events';
import { useSession } from '../../store/session';
import { fmtClock, fmtElapsed } from './format';
import DragModeSwitch from './DragModeSwitch';
import TransportIcon from './TransportIcon';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

function bounds(segments: SegmentDto[]): { t0: number; t1: number; span: number } {
  const t0 = segments[0]?.t0_ms ?? 0;
  const t1 = segments.at(-1)?.t1_ms ?? 1;
  return { t0, t1, span: Math.max(1, t1 - t0) };
}

export default function Timeline() {
  const flight = useSession((s) => s.flight);
  const syncHash = useSession((s) => s.syncHash);
  const view = useSession((s) => s.view);
  const selection = useSession((s) => s.selection);
  const events = useSession((s) => s.events);
  const resetZoom = useSession((s) => s.resetZoom);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const rangeRef = useRef<HTMLInputElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);

  const { t0, t1, span } = bounds(flight?.segments ?? []);

  useEffect(() => {
    const offState = clock.onState(() => {
      setPlaying(clock.playing);
      setSpeed(clock.speed);
    });
    // The clock ticks at 60 fps; React must not re-render for it.
    const offTime = clock.subscribe((t) => {
      if (rangeRef.current) rangeRef.current.value = String(t);
      if (clockRef.current) clockRef.current.textContent = fmtClock(t);
      if (elapsedRef.current) elapsedRef.current.textContent = fmtElapsed(t - t0);
      if (cursorRef.current) cursorRef.current.style.left = `${((t - t0) / span) * 100}%`;
    });
    // onChange fires per tick; the native change fires on release.
    const range = rangeRef.current;
    const onRelease = () => syncHash();
    range?.addEventListener('change', onRelease);
    return () => {
      offState();
      offTime();
      range?.removeEventListener('change', onRelease);
    };
  }, [t0, span, syncHash]);

  if (!flight)
    return <div className="h-full grid place-items-center text-muted">Select a recording</div>;
  if (flight.segments.length === 0)
    return <div className="h-full grid place-items-center text-muted">No recorded segments</div>;

  const toggle = () => {
    if (clock.playing) {
      clock.pause();
      syncHash();
      log.debug('timeline', 'pause', { t: clock.t, speed: clock.speed });
    } else {
      clock.play();
      log.debug('timeline', 'play', { t: clock.t, speed: clock.speed });
    }
  };
  const stop = () => {
    clock.stop();
    syncHash();
    log.debug('timeline', 'stop', { t: clock.t, speed: clock.speed });
  };
  const changeSpeed = (s: number) => {
    clock.setSpeed(s);
    log.debug('timeline', 'speed', { t: clock.t, speed: clock.speed });
  };

  return (
    <div className="h-full flex items-center gap-3 px-4">
      <div className="flex items-center gap-1">
        <button
          className="icon-btn tl-play"
          onClick={toggle}
          title={playing ? 'Pause' : 'Play'}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <TransportIcon kind={playing ? 'pause' : 'play'} />
        </button>
        <button className="icon-btn" onClick={stop} title="Stop" aria-label="Stop">
          <TransportIcon kind="stop" />
        </button>
        <select
          className="tl-btn"
          value={speed}
          onChange={(e) => changeSpeed(Number(e.target.value))}
          title="Speed"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        {view && (
          <button className="tl-btn" onClick={resetZoom} title="Reset zoom">
            Reset zoom
          </button>
        )}
        <DragModeSwitch />
      </div>
      <span ref={elapsedRef} className="tl-clock w-14 text-right" />
      <div className="relative flex-1 h-8">
        <div className="absolute inset-x-0 top-3 h-2 rounded bg-[var(--gap)]">
          {flight.segments.map((s) => (
            <div
              key={s.chunk_seq}
              className="absolute top-0 h-2 rounded bg-[var(--ahead)]"
              style={{
                left: `${((s.t0_ms - t0) / span) * 100}%`,
                width: `${((s.t1_ms - s.t0_ms) / span) * 100}%`,
              }}
              title={`chunk ${s.chunk_seq}`}
            />
          ))}
          {selection && (
            <div
              className="tl-selection"
              style={{
                left: `${((selection.t0_ms - t0) / span) * 100}%`,
                width: `${((selection.t1_ms - selection.t0_ms) / span) * 100}%`,
              }}
              title="Selected period"
            />
          )}
          {events.map((e) => (
            <button
              key={e.id}
              type="button"
              className={`tl-event ${e.instant ? 'tl-event-instant' : ''}`}
              style={{
                left: `${((e.t0_ms - t0) / span) * 100}%`,
                width: `${Math.max(0, ((e.t1_ms - e.t0_ms) / span) * 100)}%`,
              }}
              title={`${e.label} · ${fmtEventSpan(e)}`}
              aria-label={`Seek to ${e.label}`}
              onClick={() => {
                clock.seek(e.t0_ms);
                syncHash();
              }}
            />
          ))}
          {flight.markers.map((m) => (
            <div
              key={`${m.kind}-${m.t_ms}`}
              className="absolute -top-1 w-px h-4 bg-warn"
              style={{ left: `${((m.t_ms - t0) / span) * 100}%` }}
              title={`${m.kind}: ${m.text}`}
            />
          ))}
        </div>
        <div ref={cursorRef} className="absolute top-1 w-0.5 h-6 bg-accent pointer-events-none" />
        <input
          ref={rangeRef}
          type="range"
          min={t0}
          max={t1}
          step={flight.dt_ms}
          defaultValue={t0}
          className="absolute inset-0 w-full opacity-0 cursor-pointer"
          onInput={(e) => clock.seek(Number((e.target as HTMLInputElement).value))}
        />
      </div>
      <span ref={clockRef} className="tl-clock w-28" />
      <span className="tl-clock text-muted">{fmtElapsed(span)}</span>
    </div>
  );
}
