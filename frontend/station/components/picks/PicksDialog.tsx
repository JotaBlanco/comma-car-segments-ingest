import { useEffect, useRef } from 'react';
import { useSession, parsePick, type PickedSignal } from '../../store/session';
import TreeAnomalies from '../tree/TreeAnomalies';
import { KindNode, type Chosen } from '../waveform/ParamPicker';

/**
 * A workbook's picks, where the recordings tree used to be: one tree of the run's
 * protocols, sources and signals, ticked into the Picked parameters widget as ad hoc
 * parameters, and an Issues folder whose ticked rows show as events on every panel. The
 * nodes are the tree's own, bound to the session's picks; nothing is ticked by itself.
 */
export default function PicksDialog({ onClose }: { onClose(): void }) {
  const aircraft = useSession((s) => s.aircraft);
  const recording = useSession((s) => s.recording);
  const catalog = useSession((s) => s.catalog);
  const picked = useSession((s) => s.picked);
  const togglePick = useSession((s) => s.togglePick);
  const snippets = useSession((s) => s.snippets);
  const pickedSnippets = useSession((s) => s.pickedSnippets);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const keys = picked.map((p) => p.key);
  const chosen: Chosen = {
    keys,
    toggle: (key) => {
      const p: PickedSignal | null = parsePick(key);
      if (p !== null) togglePick(p);
    },
  };
  const rec = catalog?.aircraft
    .find((a) => a.id === aircraft)
    ?.recordings.find((r) => r.id === recording);
  const dated = (snippets ?? []).filter((s) => s.t0_ms !== null && s.t1_ms !== null);

  return (
    <div
      className="fts-overlay fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fts-panel modal-card picker flex max-h-[92dvh] w-full max-w-2xl flex-col p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picks-title"
      >
        <div className="flex items-center gap-3">
          <h2 id="picks-title" className="text-base font-semibold tracking-[-0.01em]">
            Signals and issues
          </h2>
          <span className="text-muted text-[13px]">
            {picked.length} {picked.length === 1 ? 'parameter' : 'parameters'} ·{' '}
            {pickedSnippets.length} of {dated.length} issues
          </span>
          <span className="flex-1" />
          <button ref={first} type="button" className="btn-primary px-3 text-[13px]" onClick={onClose}>
            Done
          </button>
        </div>
        {!rec || !aircraft ? (
          <div className="tree-empty mt-4">Open a session to pick its signals.</div>
        ) : (
          <div className="picker-tree mt-4 min-h-0 flex-1">
            <nav className="tree">
              <ul>
                {rec.tables.map((kind) => (
                  <KindNode
                    key={kind}
                    node={`${aircraft}/${rec.id}/${kind}`}
                    kind={kind}
                    chosen={chosen}
                  />
                ))}
                <TreeAnomalies />
              </ul>
            </nav>
          </div>
        )}
      </div>
    </div>
  );
}

/** The header's way in: counts on the button, the dialog on the click. */
export function PicksButton() {
  const picked = useSession((s) => s.picked.length);
  const issues = useSession((s) => s.pickedSnippets.length);
  const recording = useSession((s) => s.recording);
  const open = useSession((s) => s.picksOpen);
  const setOpen = useSession((s) => s.setPicksOpen);
  return (
    <>
      <button
        type="button"
        className="btn-ghost flex items-center gap-2"
        onClick={() => setOpen(true)}
        disabled={recording === null}
        title="Pick ad hoc parameters and the issues to show"
      >
        <SignalsIcon />
        <span>Signals</span>
        {(picked > 0 || issues > 0) && (
          <span className="text-muted font-mono text-[11px]">
            {picked} · {issues}
          </span>
        )}
      </button>
      {open && <PicksDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function SignalsIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12h4l3-8 4 16 3-8h6" />
    </svg>
  );
}
