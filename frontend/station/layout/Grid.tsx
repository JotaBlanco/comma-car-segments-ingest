import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useSession } from '../store/session';
import {
  cellAt,
  cellsFor,
  colWidth,
  effectiveLayout,
  itemRect,
  layoutHeight,
  ROW_PX,
  WIDGETS,
  widgetTitle,
  type LayoutItem,
  type PxRect,
  type WidgetId,
  type WidgetKind,
} from './dashboard';
import Waveform, { WaveformActions } from '../components/waveform/Waveform';
import type { PanelId } from './panels';
import PanelShell from './PanelShell';

const GAP_FALLBACK = 10;

interface Drag {
  id: WidgetId;
  /** The widget's kind: its minimum size bounds a resize. */
  of: WidgetKind;
  kind: 'move' | 'resize';
  /** The pointer where the drag began, in client px. */
  originX: number;
  originY: number;
  /** The item's rectangle when the drag began, in grid px. */
  from: PxRect;
  /** The rectangle under the pointer now, in grid px: the panel follows it. */
  ghost: PxRect;
}

/**
 * The dashboard: every widget in its cells, absolutely placed so a move animates and a drag
 * follows the pointer. The container measures itself; one column is a share of its width.
 *
 * In edit mode a title bar starts a move and a corner starts a resize. The dragged panel
 * follows the pointer in pixels while a placeholder shows the cell it will land on, and the
 * store re-solves the layout every time that cell changes, so the other widgets make room live.
 */
export default function Grid({ widgets }: { widgets: Record<PanelId, ReactNode> }) {
  const layout = useSession((s) => s.layout);
  const collapsed = useSession((s) => s.collapsed);
  const editing = useSession((s) => s.editing);
  const moveWidget = useSession((s) => s.moveWidget);
  const resizeWidget = useSession((s) => s.resizeWidget);
  const removeWidget = useSession((s) => s.removeWidget);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [gap, setGap] = useState(GAP_FALLBACK);
  const [dragState, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  // Leaving edit mode drops any drag in flight: the state is read only while editing.
  const drag = editing ? dragState : null;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const read = () => {
      setWidth(el.clientWidth);
      const g = parseFloat(getComputedStyle(el).getPropertyValue('--space'));
      setGap(Number.isFinite(g) && g > 0 ? g : GAP_FALLBACK);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = useMemo(() => effectiveLayout(layout, collapsed), [layout, collapsed]);
  const colW = colWidth(width, gap);
  const rows = Math.max(layoutHeight(shown), 1);
  const height = rows * ROW_PX + (rows - 1) * gap;

  const start = (
    kind: Drag['kind'],
    item: LayoutItem,
    e: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (!editing || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const from = itemRect(item, colW, gap);
    const d: Drag = {
      id: item.id,
      of: item.kind,
      kind,
      originX: e.clientX,
      originY: e.clientY,
      from,
      ghost: from,
    };
    dragRef.current = d;
    setDrag(d);
    const move = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const dx = ev.clientX - cur.originX;
      const dy = ev.clientY - cur.originY;
      let ghost: PxRect;
      if (cur.kind === 'move') {
        ghost = { ...cur.from, left: cur.from.left + dx, top: cur.from.top + dy };
        const cell = cellAt(ghost.left, ghost.top, colW, gap);
        moveWidget(cur.id, cell.x, cell.y);
      } else {
        const spec = WIDGETS[cur.of];
        ghost = {
          ...cur.from,
          width: Math.max(cur.from.width + dx, spec.minW * colW),
          height: Math.max(cur.from.height + dy, spec.minH * ROW_PX),
        };
        const size = cellsFor(ghost.width, ghost.height, colW, gap);
        resizeWidget(cur.id, size.w, size.h);
      }
      const next = { ...cur, ghost };
      dragRef.current = next;
      setDrag(next);
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      dragRef.current = null;
      setDrag(null);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  const rectStyle = (r: PxRect): CSSProperties => ({
    transform: `translate(${Math.round(r.left)}px, ${Math.round(r.top)}px)`,
    width: Math.round(r.width),
    height: Math.round(r.height),
  });

  const target = drag ? shown.find((it) => it.id === drag.id) : undefined;

  return (
    <div
      ref={host}
      className={`dash ${editing ? 'dash-editing' : ''} ${drag ? `dash-dragging dash-${drag.kind}` : ''}`}
      style={{ height }}
    >
      {drag && target && (
        <div className="dash-placeholder" style={rectStyle(itemRect(target, colW, gap))} />
      )}
      {shown.map((item) => {
        const dragging = drag?.id === item.id;
        const rect = dragging && drag ? drag.ghost : itemRect(item, colW, gap);
        return (
          <div
            key={item.id}
            className={`dash-item ${dragging ? 'dash-item-dragging' : ''} ${width === 0 ? 'dash-item-unmeasured' : ''}`}
            style={rectStyle(rect)}
          >
            <PanelShell
              id={item.id}
              kind={item.kind}
              title={widgetTitle(item)}
              actions={item.kind === 'waveform' ? <WaveformActions item={item} /> : undefined}
              editing={editing}
              onMoveStart={(e) => start('move', item, e)}
              onResizeStart={(e) => start('resize', item, e)}
              onRemove={() => removeWidget(item.id)}
            >
              {item.kind === 'waveform' ? <Waveform item={item} /> : widgets[item.kind]}
            </PanelShell>
          </div>
        );
      })}
    </div>
  );
}
