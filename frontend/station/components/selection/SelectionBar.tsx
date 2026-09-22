import { useMemo } from 'react';
import { clock } from '../../playback/clock';
import {
  fmtDelta,
  fmtDistance,
  fmtNum,
  fmtSpan,
  summarize,
  type ParamDelta,
} from '../../selection/summary';
import { useSession } from '../../store/session';
import { fmtClock } from '../timeline/format';

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

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="selbar-stat" title={title}>
      <span className="selbar-label">{label}</span>
      <span className="selbar-value readout">{value}</span>
    </div>
  );
}

function Delta({ p }: { p: ParamDelta }) {
  const tone = p.delta > 0 ? 'selbar-up' : p.delta < 0 ? 'selbar-down' : '';
  const detail = `${p.label}: ${fmtNum(p.start)} → ${fmtNum(p.end)} ${p.unit}, min ${fmtNum(p.min)}, max ${fmtNum(p.max)}`;
  return (
    <div className="selbar-stat" title={detail}>
      <span className="selbar-label">{p.label}</span>
      <span className={`selbar-value readout ${tone}`}>{fmtDelta(p.delta, p.unit)}</span>
      <span className="selbar-sub readout">
        {fmtNum(p.start)} → {fmtNum(p.end)}
      </span>
    </div>
  );
}

/** What the marked period holds: its span, the ground covered, how the flight changed. */
export default function SelectionBar() {
  const flight = useSession((s) => s.flight);
  const selection = useSession((s) => s.selection);
  const clearSelection = useSession((s) => s.clearSelection);
  const setView = useSession((s) => s.setView);
  const syncHash = useSession((s) => s.syncHash);
  const summary = useMemo(
    () => (flight && selection ? summarize(flight, selection) : null),
    [flight, selection],
  );
  if (!summary || !selection) return null;
  const seekStart = () => {
    clock.seek(selection.t0_ms);
    syncHash();
  };
  return (
    <div className="selbar" role="status" aria-label="Selected period">
      <span className="selbar-mark" aria-hidden="true" />
      <Stat
        label="Selected"
        value={`${fmtClock(summary.t0_ms)} → ${fmtClock(summary.t1_ms)}`}
        title="UTC"
      />
      <Stat label="Duration" value={fmtSpan(summary.span_ms)} />
      {summary.distance_m !== null && (
        <Stat label="Ground track" value={fmtDistance(summary.distance_m)} />
      )}
      <span className="selbar-divider" aria-hidden="true" />
      {summary.params.map((p) => (
        <Delta key={p.col} p={p} />
      ))}
      {summary.frames === 0 && <span className="text-muted text-xs">outside the recording</span>}
      <span className="flex-1" />
      <button type="button" className="tl-btn" onClick={seekStart} title="Seek to the start">
        Go to start
      </button>
      <button
        type="button"
        className="tl-btn"
        onClick={() => setView(selection)}
        title="Zoom the charts to this period"
      >
        Zoom to
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={clearSelection}
        title="Clear selection (Esc)"
        aria-label="Clear selection"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
