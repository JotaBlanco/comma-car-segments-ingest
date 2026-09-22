import { useRef, useState, type ReactNode } from 'react';
import SidebarIcon from '../components/header/SidebarIcon';
import { useSession } from '../store/session';
import type { PanelId } from './panels';
import Gallery from './Gallery';
import Grid from './Grid';
import { TREE_WIDTH_DEFAULT } from './sidebar';

interface Slots {
  header: ReactNode;
  tree: ReactNode;
  /** One node per widget; the grid places whichever the dashboard holds. */
  widgets: Record<PanelId, ReactNode>;
  /** The marked period's summary; renders nothing without a selection. */
  selection: ReactNode;
  timeline: ReactNode;
}

/** An empty dashboard is a place to start, not a fault. */
function Empty() {
  const [gallery, setGallery] = useState(false);
  return (
    <div className="dash-empty">
      <p className="text-[13px] font-semibold">Nothing on the dashboard</p>
      <p className="text-muted text-[13px]">
        Add widgets from the gallery, or start from a preset.
      </p>
      <button
        type="button"
        className="btn-primary px-3 text-[13px]"
        onClick={() => setGallery(true)}
      >
        Open the widget gallery
      </button>
      {gallery && <Gallery onClose={() => setGallery(false)} />}
    </div>
  );
}

/** Fixed header and timeline; tree left; the dashboard scrolls. */
export default function Layout(s: Slots) {
  const layout = useSession((st) => st.layout);
  const treeOpen = useSession((st) => st.treeOpen);
  const treeWidth = useSession((st) => st.treeWidth);
  const toggleTree = useSession((st) => st.toggleTree);
  const setTreeWidth = useSession((st) => st.setTreeWidth);
  const aside = useRef<HTMLElement>(null);
  const label = 'Collapse sidebar';
  const [resizing, setResizing] = useState(false);
  const theme = useSession((st) => st.theme);
  /* A workbook picks its runs in the Test Manager, so the recordings tree stays away. */
  const withTree = useSession((st) => st.workbook === null);
  const showTree = withTree && treeOpen;
  const columns = `${showTree ? treeWidth : 0}px 1fr`;

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const left = aside.current?.getBoundingClientRect().left ?? 0;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    const move = (ev: PointerEvent) => setTreeWidth(ev.clientX - left);
    const stop = () => {
      setResizing(false);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
  };

  return (
    <div
      className="fts-root relative h-full grid grid-rows-[3.25rem_1fr_auto_4.5rem] bg-bg text-text"
      data-theme={theme}
    >
      <div className="app-header border-b border-border bg-chrome">{s.header}</div>
      <div
        className={`sidebar-grid min-h-0 grid ${resizing ? 'sidebar-grid-resizing' : ''}`}
        style={{ gridTemplateColumns: columns }}
      >
        {/* clipped to 0, not unmounted: expanded scopes survive */}
        <aside
          ref={aside}
          className={`relative min-h-0 flex flex-col overflow-hidden bg-chrome ${showTree ? 'border-r border-border' : ''}`}
          inert={!showTree || undefined}
          aria-hidden={!showTree}
        >
          <div className="min-h-0 flex-1 flex flex-col" style={{ width: treeWidth }}>
            <div className="sidebar-title">Recordings</div>
            <div className="min-h-0 flex-1 overflow-auto">{s.tree}</div>
          </div>
          <button
            className="sidebar-toggle"
            style={{ width: treeWidth }}
            onClick={toggleTree}
            aria-label={label}
            aria-expanded={treeOpen}
            title={label}
          >
            <SidebarIcon open />
            <span>Collapse sidebar</span>
          </button>
        </aside>
        {showTree && (
          <div
            className="sidebar-resizer row-divider"
            style={{ left: treeWidth }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Drag to resize, double-click to reset"
            onPointerDown={startResize}
            onDoubleClick={() => setTreeWidth(TREE_WIDTH_DEFAULT)}
          />
        )}

        <main className="main-grid min-h-0 overflow-auto">
          {layout.length === 0 ? <Empty /> : <Grid widgets={s.widgets} />}
        </main>
      </div>
      <div className="min-h-0">{s.selection}</div>
      <div className="fts-transport border-t border-border">{s.timeline}</div>
    </div>
  );
}
