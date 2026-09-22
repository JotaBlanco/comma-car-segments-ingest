import type { ReactNode } from 'react';
import LayoutBar from '../../layout/LayoutBar';
import { useSession } from '../../store/session';
import { PicksButton } from '../picks/PicksDialog';
import { formatRecordingId } from '../tree/format';
import BrandMark from './BrandMark';
import LayoutIcon from './LayoutIcon';
import SidebarIcon from './SidebarIcon';
import ThemeIcon from './ThemeIcon';

/**
 * The one header row. On its own the station leads with its brand; inside a Test Manager
 * workbook the workbook's controls lead instead, and the brand stays out of the way.
 */
export default function Header({
  leading,
  trailing,
}: {
  leading?: ReactNode;
  /** The Test Manager's controls before the layout controls, inside a workbook. */
  trailing?: ReactNode;
}) {
  const aircraft = useSession((s) => s.aircraft);
  const recording = useSession((s) => s.recording);
  const theme = useSession((s) => s.theme);
  const toggleTheme = useSession((s) => s.toggleTheme);
  const treeOpen = useSession((s) => s.treeOpen);
  const toggleTree = useSession((s) => s.toggleTree);
  const resetView = useSession((s) => s.resetView);
  const resetLayout = useSession((s) => s.resetLayout);
  const workbook = useSession((s) => s.workbook);
  const loading = useSession((s) => s.loading);
  const flight = useSession((s) => s.flight);
  const busy = loading && !!recording && !flight;
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const breadcrumb = aircraft && recording && (
    <span className="text-muted text-[13px]" title={`${aircraft}/${recording}`}>
      {aircraft.toUpperCase()} · {formatRecordingId(recording)}
    </span>
  );
  return (
    <div className="h-full flex items-center justify-between gap-4 px-4">
      <div className="flex min-w-0 items-center gap-3">
        {!treeOpen && workbook === null && (
          <button
            className="icon-btn"
            onClick={toggleTree}
            aria-label="Expand sidebar"
            aria-expanded={false}
            title="Expand sidebar"
          >
            <SidebarIcon open={false} />
          </button>
        )}
        {workbook === null ? (
          <button
            className="brand-home flex items-center gap-3"
            onClick={resetView}
            title="Back to start"
            aria-label="Back to start"
          >
            <BrandMark className="size-[26px] flex-none" />
            <span className="font-bold tracking-[-0.01em]">Flight Test Station</span>
          </button>
        ) : (
          <>
            {leading}
            <PicksButton />
          </>
        )}
        {breadcrumb}
        {busy && (
          <span className="busy-pill" role="status" aria-live="polite">
            <span className="busy-ring" aria-hidden="true" />
            Loading flight
          </span>
        )}
      </div>
      {busy && <span className="busy-bar" aria-hidden="true" />}
      <div className="flex items-center gap-3">
        {workbook !== null && trailing}
        <LayoutBar />
        {/* A workbook's reset sits in its edit mode, and its theme is the Test Manager's. */}
        {workbook === null && (
          <>
            <button
              className="icon-btn"
              onClick={resetLayout}
              aria-label="Reset layout"
              title="Reset layout"
            >
              <LayoutIcon />
            </button>
            <button className="icon-btn" onClick={toggleTheme} aria-label={label} title={label}>
              <ThemeIcon theme={theme} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
