import { useState } from 'react';
import type { SnippetDto } from '../../api/types';
import { eventLabel, fmtEventSpan, pickedEvents } from '../../selection/events';
import { useSession } from '../../store/session';
import { fmtClock } from '../timeline/format';
import { CheckIcon, ChevronIcon } from './icons';
import KeyTag from './KeyTag';

/** A flag: the anomalies folder. */
function FlagIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 21V4" />
      <path d="M5 4h12l-2.5 4L17 12H5" />
    </svg>
  );
}

/** When the snippet marks, for the row's right edge: `14:10 · 1m 00s`, `14:40 · instant`. */
function when(s: SnippetDto): string {
  if (s.t0_ms === null || s.t1_ms === null) return 'undated';
  const [e] = pickedEvents([s], [s.id]);
  return `${fmtClock(s.t0_ms).slice(0, 5)} · ${fmtEventSpan(e)}`;
}

function SnippetRow({ s }: { s: SnippetDto }) {
  const on = useSession((st) => st.pickedSnippets.includes(s.id));
  const toggleSnippet = useSession((st) => st.toggleSnippet);
  const dated = s.t0_ms !== null && s.t1_ms !== null;
  const title = [
    s.name,
    s.note,
    s.t0_ms !== null ? `At ${fmtClock(s.t0_ms)}` : '',
    s.found_by ? `Found by ${s.found_by}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <li>
      <label
        className={`tree-row tree-signal tree-anomaly ${on ? 'tree-picked' : ''}`}
        title={title}
      >
        <span className="tree-spacer" />
        <input
          className="tree-check-input"
          type="checkbox"
          checked={on}
          disabled={!dated}
          onChange={() => toggleSnippet(s.id)}
        />
        <span className={`tree-check ${on ? 'tree-check-alarm' : ''}`}>{on && <CheckIcon />}</span>
        <span className="tree-label">{eventLabel(s)}</span>
        <KeyTag name="snippet" />
        <span className="tree-meta">{when(s)}</span>
      </label>
    </li>
  );
}

/** The folder's rows: the wait, the empty note, select-all, then one row per snippet. */
function AnomalyRows({ snippets, loading }: { snippets: SnippetDto[] | null; loading: boolean }) {
  const picked = useSession((s) => s.pickedSnippets);
  const pickAll = useSession((s) => s.pickAllSnippets);
  if (snippets === null) {
    return (
      <li className="tree-row tree-pending">
        {loading && <span className="tree-spinner" aria-hidden="true" />}
        <span className="text-muted">{loading ? 'Loading…' : 'Not looked up yet'}</span>
      </li>
    );
  }
  if (snippets.length === 0) {
    return (
      <li className="tree-row tree-pending">
        <span className="tree-spacer" />
        <span className="text-muted">No data snippets for this recording</span>
      </li>
    );
  }
  const dated = snippets.filter((s) => s.t0_ms !== null && s.t1_ms !== null);
  const allOn = dated.length > 0 && dated.every((s) => picked.includes(s.id));
  return (
    <>
      {dated.length > 0 && (
        <li>
          <label className="tree-row tree-signal tree-select-all">
            <span className="tree-spacer" />
            <input
              className="tree-check-input"
              type="checkbox"
              checked={allOn}
              onChange={() => pickAll(!allOn)}
            />
            <span className={`tree-check ${allOn ? 'tree-check-alarm' : ''}`}>
              {allOn && <CheckIcon />}
            </span>
            <span className="tree-label">{allOn ? 'Clear all' : 'Select all'}</span>
            <span className="tree-meta">{dated.length}</span>
          </label>
        </li>
      )}
      {snippets.map((s) => (
        <SnippetRow key={s.id} s={s} />
      ))}
    </>
  );
}

/** The recording's data snippets (QuixLab's anomalies, saved selections): pick all or one,
 *  and each becomes an event on every panel. Looked up when the recording opens. */
export default function TreeAnomalies() {
  const [open, setOpen] = useState(false);
  const snippets = useSession((s) => s.snippets);
  const loading = useSession((s) => s.snippetsLoading);
  const pickedCount = useSession((s) => s.pickedSnippets.length);
  const loadSnippets = useSession((s) => s.loadSnippets);
  const toggle = () => {
    if (!open && snippets === null) void loadSnippets();
    setOpen(!open);
  };
  return (
    <li>
      <button
        className={`tree-row tree-kind tree-anomalies ${open ? 'tree-open' : ''}`}
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronIcon open={open} />
        <FlagIcon className="tree-icon tree-icon-anomaly" />
        <span className="tree-label">Issues</span>
        <KeyTag name="snippet" />
        {pickedCount > 0 && <span className="tree-count tree-count-alarm">{pickedCount}</span>}
        {snippets && <span className="tree-meta">{snippets.length}</span>}
      </button>
      {open && (
        <ul className="tree-children">
          <AnomalyRows snippets={snippets} loading={loading} />
        </ul>
      )}
    </li>
  );
}
