import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useSession } from '../store/session';
import type { WidgetId, WidgetKind } from './dashboard';
import PanelIcon from './PanelIcon';

interface Props {
  id: WidgetId;
  kind: WidgetKind;
  title: string;
  children: ReactNode;
  /** The widget's own controls on the title bar, before the collapse button. */
  actions?: ReactNode;
  style?: CSSProperties;
  /** Edit mode: the title bar drags the panel, the corner resizes it, and a cross removes it. */
  editing?: boolean;
  onMoveStart?(e: ReactPointerEvent<HTMLDivElement>): void;
  onResizeStart?(e: ReactPointerEvent<HTMLDivElement>): void;
  onRemove?(): void;
}

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`panel-chevron ${collapsed ? 'panel-chevron-collapsed' : ''}`}
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
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Cross() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function RemoveButton({ title, onRemove }: { title: string; onRemove?: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn panel-collapse"
      onClick={onRemove}
      aria-label={`Remove ${title}`}
      title={`Remove ${title} from the dashboard`}
    >
      <Cross />
    </button>
  );
}

/** The corner you drag to resize; the grid owns the geometry. */
function Grip({
  title,
  onResizeStart,
}: {
  title: string;
  onResizeStart?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className="panel-grip"
      role="separator"
      aria-label={`Resize ${title}`}
      title="Drag to resize"
      onPointerDown={onResizeStart}
    />
  );
}

function shellClass(collapsed: boolean, editing: boolean): string {
  const out = ['panel', 'panel-shell'];
  if (collapsed) out.push('panel-collapsed');
  if (editing) out.push('panel-editing');
  return out.join(' ');
}

/** A press on the bar starts a move in edit mode; a button on the bar is a click. */
function startsDrag(e: ReactPointerEvent<HTMLDivElement>, editing: boolean): boolean {
  return editing && (e.target as HTMLElement).closest('button') === null;
}

/** Title bar plus a body that unmounts when collapsed. */
export default function PanelShell({
  id,
  kind,
  title,
  children,
  style,
  actions,
  editing = false,
  onMoveStart,
  onResizeStart,
  onRemove,
}: Props) {
  const collapsed = useSession((s) => s.collapsed[id] ?? false);
  const togglePanel = useSession((s) => s.togglePanel);
  const label = `${collapsed ? 'Expand' : 'Collapse'} ${title}`;
  const grab = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (startsDrag(e, editing)) onMoveStart?.(e);
  };
  return (
    <section className={shellClass(collapsed, editing)} style={style}>
      <div
        className={editing ? 'panel-head panel-head-grab' : 'panel-head'}
        onPointerDown={grab}
        title={editing ? 'Drag to move' : undefined}
      >
        <PanelIcon id={kind} />
        <span className="panel-title">{title}</span>
        {actions}
        {editing && <RemoveButton title={title} onRemove={onRemove} />}
        <button
          type="button"
          className="icon-btn panel-collapse"
          onClick={() => togglePanel(id)}
          aria-expanded={!collapsed}
          aria-label={label}
          title={label}
        >
          <Chevron collapsed={collapsed} />
        </button>
      </div>
      {/* Unmounted, not hidden: Leaflet and uPlot re-measure. */}
      {!collapsed && <div className="panel-body">{children}</div>}
      {!collapsed && editing && <Grip title={title} onResizeStart={onResizeStart} />}
    </section>
  );
}
