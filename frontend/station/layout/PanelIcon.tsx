import type { WidgetKind } from './dashboard';

const PATHS: Record<WidgetKind, string> = {
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
  altitude: 'M3 17l5-6 4 3 4-7 5 5',
  instruments: 'M12 20a8 8 0 1 1 8-8M12 12l4-4M12 12h.01',
  annunciator: 'M4 6h16v9H4zM8 19h8M12 15v4',
  strips: 'M3 5h18M3 12h18M3 19h18M6 9l3-2 3 2M6 16l3-2 3 2',
  waveform: 'M2 12h3l2-7 3 14 3-10 2 6 2-3h5',
};

/** The panel's glyph, sitting before its title. */
export default function PanelIcon({ id }: { id: WidgetKind }) {
  return (
    <svg
      className="panel-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[id]} />
    </svg>
  );
}
