import { useEffect, useRef, type Ref } from 'react';
import type { MarkerDto } from '../../api/types';
import { log } from '../../log';
import { clock } from '../../playback/clock';
import { frameIndex, valueAt } from '../../playback/frames';
import { makeThrottle } from '../../playback/throttle';
import { useSession } from '../../store/session';
import { fmtClock } from '../timeline/format';
import { lampFor } from './lamp';

const PHASE_CLASS: Record<string, string> = {
  '0': 'lamp-idle',
  '1': 'lamp-ok',
  '2': 'lamp-ok',
  '3': 'lamp-ok',
  '4': 'lamp-warn',
};

function State({ label, lampRef }: { label: string; lampRef: Ref<HTMLDivElement> }) {
  return (
    <div>
      <div className="text-muted uppercase text-[10px]">{label}</div>
      <div ref={lampRef} className="lamp readout lamp-off">
        —
      </div>
    </div>
  );
}

function Event({
  marker,
  selected,
  onSeek,
}: {
  marker: MarkerDto;
  /** Inside the marked period. */
  selected: boolean;
  onSeek: (m: MarkerDto) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-t={marker.t_ms}
        className={`event-row readout ${selected ? 'event-selected' : ''}`}
        onClick={() => onSeek(marker)}
      >
        <span className="text-muted">{fmtClock(marker.t_ms)}</span>{' '}
        {marker.kind.replaceAll('_', ' ')} → {marker.text}
      </button>
    </li>
  );
}

export default function Annunciator() {
  const flight = useSession((s) => s.flight);
  const selection = useSession((s) => s.selection);
  const syncHash = useSession((s) => s.syncHash);
  const phaseEl = useRef<HTMLDivElement>(null);
  const fcsEl = useRef<HTMLDivElement>(null);
  const listEl = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!flight) return;
    const gate = makeThrottle(100);
    return clock.subscribe((t) => {
      if (!gate()) return;
      const i = frameIndex(flight.t0_ms, flight.dt_ms, flight.n, t);
      const phase = lampFor(
        valueAt(flight.cols.phase, i),
        flight.texts.phase,
        'PHASE',
        PHASE_CLASS,
      );
      const fcs = lampFor(valueAt(flight.cols.fcs, i), flight.texts.fcs, 'FCS', {});
      if (phaseEl.current) {
        phaseEl.current.textContent = phase.label;
        phaseEl.current.className = phase.cls;
      }
      if (fcsEl.current) {
        fcsEl.current.textContent = fcs.label;
        fcsEl.current.className = fcs.cls;
      }
      listEl.current?.querySelectorAll<HTMLButtonElement>('button[data-t]').forEach((b) => {
        b.classList.toggle('past', Number(b.dataset.t) <= t);
      });
    });
  }, [flight]);

  if (!flight) {
    return <div className="h-full grid place-items-center text-muted">No flight state</div>;
  }

  const onSeek = (m: MarkerDto) => {
    clock.seek(m.t_ms);
    syncHash();
    log.debug('annunciator', 'seek to event', { t: m.t_ms, kind: m.kind });
  };

  return (
    <div className="h-full p-2 flex flex-col gap-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <State label={`Flight phase · ${flight.source.phase}`} lampRef={phaseEl} />
        <State label={`FCS state · ${flight.source.fcs}`} lampRef={fcsEl} />
      </div>
      <div className="text-muted uppercase text-[10px] mt-1">Events</div>
      <ul ref={listEl} className="flex-1 overflow-auto">
        {flight.markers.length === 0 && (
          <li className="text-muted">no state changes in this recording</li>
        )}
        {flight.markers.map((m) => (
          <Event
            key={`${m.kind}-${m.t_ms}`}
            marker={m}
            selected={selection !== null && m.t_ms >= selection.t0_ms && m.t_ms <= selection.t1_ms}
            onSeek={onSeek}
          />
        ))}
      </ul>
    </div>
  );
}
