import type { DragMode } from '../../selection/drag';
import { useSession } from '../../store/session';

function ZoomIcon() {
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
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3M8 11h6M11 8v6" />
    </svg>
  );
}

function SelectIcon() {
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
      <path d="M8 4H5v16h3M16 4h3v16h-3" />
      <path d="M9 12h6" strokeDasharray="2 2" />
    </svg>
  );
}

const MODES: { mode: DragMode; label: string; hint: string }[] = [
  { mode: 'zoom', label: 'Zoom', hint: 'Drag on a chart to zoom in (Shift+drag selects)' },
  { mode: 'select', label: 'Select', hint: 'Drag on a chart to mark a period (Shift+drag zooms)' },
];

/** What a drag on any chart does. */
export default function DragModeSwitch() {
  const dragMode = useSession((s) => s.dragMode);
  const setDragMode = useSession((s) => s.setDragMode);
  return (
    <div className="tl-seg" role="radiogroup" aria-label="Drag action">
      {MODES.map(({ mode, label, hint }) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={dragMode === mode}
          className={`tl-seg-btn ${dragMode === mode ? 'tl-seg-on' : ''}`}
          onClick={() => setDragMode(mode)}
          title={hint}
        >
          {mode === 'zoom' ? <ZoomIcon /> : <SelectIcon />}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
