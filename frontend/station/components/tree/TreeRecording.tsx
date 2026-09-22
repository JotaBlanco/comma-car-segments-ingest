import type { Recording } from '../../api/types';
import { log } from '../../log';
import { useSession } from '../../store/session';
import { formatDuration, formatRecordingId } from './format';
import { ChevronIcon, FlightIcon, KindIcon } from './icons';
import KeyTag from './KeyTag';
import TreeParams from './TreeParams';

/** Seconds a recording spans, once its flight state (the only data read) is loaded. */
function durationOf(segments: { t0_ms: number; t1_ms: number }[]): number | null {
  if (segments.length === 0) return null;
  const t0 = Math.min(...segments.map((s) => s.t0_ms));
  const t1 = Math.max(...segments.map((s) => s.t1_ms));
  return Math.round((t1 - t0) / 1000);
}

/** The open recording shows its duration; a closed one, its protocols as icons. */
function Meta({ rec, dur }: { rec: Recording; dur: number | null }) {
  if (dur !== null) return <span className="tree-meta">{formatDuration(dur)}</span>;
  return (
    <span className="tree-meta tree-kinds" title={rec.tables.join(' · ')}>
      {rec.tables.map((t) => (
        <KindIcon key={t} kind={t} className={`tree-icon tree-icon-${t}`} />
      ))}
    </span>
  );
}

interface RowState {
  active: boolean;
  busy: boolean;
  dur: number | null;
  onClick: () => void;
}

/** What one recording row shows and does, from the session it belongs to. */
function useRow(aircraft: string, rec: Recording): RowState {
  const recording = useSession((s) => s.recording);
  const currentAircraft = useSession((s) => s.aircraft);
  const flight = useSession((s) => s.flight);
  const selectRecording = useSession((s) => s.selectRecording);
  const resetView = useSession((s) => s.resetView);
  const loading = useSession((s) => s.loading);
  const active = recording === rec.id && currentAircraft === aircraft;
  const select = () => {
    log.debug('tree', 'select recording', { aircraft, recording: rec.id });
    void selectRecording(aircraft, rec.id);
  };
  const close = () => {
    // The open recording closes on a second click: back to the empty station.
    log.debug('tree', 'close recording', { aircraft, recording: rec.id });
    resetView();
  };
  return {
    active,
    busy: active && loading && !flight,
    dur: active && flight ? durationOf(flight.segments) : null,
    onClick: active ? close : select,
  };
}

export default function TreeRecording({ aircraft, rec }: { aircraft: string; rec: Recording }) {
  const { active, busy, dur, onClick } = useRow(aircraft, rec);
  return (
    <li>
      <button
        className={`tree-row tree-recording ${active ? 'tree-active tree-open' : ''}`}
        aria-expanded={active}
        aria-current={active ? 'true' : undefined}
        onClick={onClick}
        title={active ? `${rec.run_id} — click to close` : rec.run_id}
      >
        {busy ? (
          <span className="tree-spinner" aria-label="Loading" />
        ) : (
          <ChevronIcon open={active} />
        )}
        <FlightIcon className="tree-icon tree-icon-flight" />
        <span className="tree-label">{formatRecordingId(rec.id)}</span>
        <KeyTag name="run_id" />
        <Meta rec={rec} dur={dur} />
      </button>
      {active && <TreeParams aircraft={aircraft} rec={rec} />}
    </li>
  );
}
