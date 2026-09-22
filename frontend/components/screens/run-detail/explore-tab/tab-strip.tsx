"use client";

/**
 * Explore workbench tab strip — N editor tabs + a "+" menu, ported from the
 * QuixLake console's TabBar and restyled to the Test Manager idiom (underline
 * active indicator, like TabsList variant="line").
 *
 * A11y shape, deliberate:
 *  - the tablist contains ONLY role="tab" buttons (axe aria-required-children);
 *    the "+" menu and any right-side controls live outside it in the same row.
 *  - the close affordance is a plain span inside the tab button — no role, no
 *    tabindex — so axe's nested-interactive rule stays green. The keyboard
 *    path is Delete/Backspace on the focused tab; middle-click also closes.
 *  - roving tabindex: only the active tab is tabbable; ArrowLeft/ArrowRight
 *    move activation.
 *  - inline rename: double-click or F2 swaps the label for an input (inside a
 *    role="tab" div so the tablist keeps only tabs). Enter commits, Escape
 *    cancels, blur commits; every other key — Delete included — types.
 *  - reorder: press a tab and drag horizontally past a small threshold
 *    (DRAG_THRESHOLD_PX) to pick it up — the dragged tab follows the pointer,
 *    siblings shift with a transition, drop commits. A plain click still
 *    activates and double-click still renames; the click that follows a
 *    completed drag is suppressed, and a drag never starts from the × or the
 *    rename input. Keyboard parity is Ctrl/Cmd+ArrowLeft/ArrowRight on the
 *    focused tab (moves it one slot, no wrap; plain arrows keep moving
 *    activation). Order is purely visual — no live region, no new roles.
 */

import {
  memo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MAX_EXPLORE_TABS,
  MAX_TAB_TITLE,
  type ExploreTabItem,
  type ExploreTabKind,
} from "@/lib/explore/tabs";
import { cn } from "@/lib/utils";

function KindIcon({ kind }: { kind: ExploreTabKind }) {
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;
  if (kind === "sql") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...stroke}>
        <path d="m8 8-4 4 4 4M16 8l4 4-4 4" />
      </svg>
    );
  }
  if (kind === "ai") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...stroke}>
        <path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden {...stroke}>
      <path d="M3 17 9 11l4 4 8-8" />
    </svg>
  );
}

/** Horizontal travel (px) that turns a press into a drag instead of a click. */
const DRAG_THRESHOLD_PX = 4;

/** The tablist's gap-0.5 — added to the dragged width when siblings shift. */
const TAB_GAP_PX = 2;

/** Live drag — exists only after a press travels past DRAG_THRESHOLD_PX. */
interface DragState {
  id: string;
  fromIndex: number;
  /** Pointer travel since pointerdown; the dragged tab's translateX. */
  dx: number;
  /** Slot the tab lands in if dropped now (index after removal — reducer shape). */
  toIndex: number;
  /** Tab center x-coordinates snapshotted at drag start, in tab order. */
  centers: number[];
  /** Dragged tab's width — how far displaced siblings shift. */
  width: number;
}

export interface TabStripProps {
  tabs: readonly ExploreTabItem[];
  activeId: string;
  aiAvailable: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: (kind: ExploreTabKind) => void;
  /** Rename a tab (double-click or F2). Trim/empty rules live in the reducer. */
  onRename: (id: string, title: string) => void;
  /** Move a tab to an index (drag or Ctrl/Cmd+Arrow). Clamping lives in the reducer. */
  onReorder: (id: string, index: number) => void;
  /** Right-aligned controls (the History toggle) — rendered outside the tablist. */
  children?: ReactNode;
}

export const TabStrip = memo(function TabStrip({
  tabs,
  activeId,
  aiAvailable,
  onActivate,
  onClose,
  onCreate,
  onRename,
  onReorder,
  children,
}: TabStripProps) {
  const atCap = tabs.length >= MAX_EXPLORE_TABS;
  const canClose = tabs.length > 1;
  /** Inline rename state — the tab being edited and its draft title. */
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);

  const startRename = (tab: ExploreTabItem) => setEditing({ id: tab.id, draft: tab.title });
  /** `restoreFocus` for keyboard exits; blur-commit must not steal focus. */
  const endRename = (commit: boolean, restoreFocus: boolean) => {
    if (editing === null) return;
    const { id, draft } = editing;
    if (commit) onRename(id, draft);
    setEditing(null);
    if (restoreFocus) {
      requestAnimationFrame(() => document.getElementById(`explore-tab-${id}`)?.focus());
    }
  };

  /* ---- pointer-drag reorder -------------------------------------------- */

  /** Armed on pointerdown; becomes a DragState once past the threshold. */
  const pressRef = useRef<{ id: string; startX: number } | null>(null);
  /** A completed drag ends in a click — swallow exactly that one. */
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);

  const onTabPointerDown = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    // A fresh press always clears stale drag bookkeeping.
    suppressClickRef.current = false;
    if (event.button !== 0) return;
    // The × closes — it never picks the tab up.
    if ((event.target as HTMLElement).closest("[data-tab-close]") !== null) return;
    pressRef.current = { id, startX: event.clientX };
  };

  const onTabPointerMove = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    const press = pressRef.current;
    if (press === null || press.id !== id) return;
    const dx = event.clientX - press.startX;

    let current = drag;
    if (current === null) {
      if (Math.abs(dx) <= DRAG_THRESHOLD_PX) return;
      // Same capture pattern as the splitter/schema-rail handles; jsdom's
      // PointerEvent has no real capture, hence the guard.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom */
      }
      const fromIndex = tabs.findIndex((tab) => tab.id === id);
      if (fromIndex === -1) return;
      const centers = tabs.map((tab) => {
        const rect = document.getElementById(`explore-tab-${tab.id}`)?.getBoundingClientRect();
        return rect === undefined ? 0 : rect.left + rect.width / 2;
      });
      const width =
        document.getElementById(`explore-tab-${id}`)?.getBoundingClientRect().width ?? 0;
      current = { id, fromIndex, dx, toIndex: fromIndex, centers, width };
    }

    // The slot the dragged center has crossed into: count the OTHER tabs whose
    // snapshotted center sits left of it — that count is exactly the reducer's
    // insert-after-removal index.
    const draggedCenter = current.centers[current.fromIndex] + dx;
    let toIndex = 0;
    for (let index = 0; index < current.centers.length; index += 1) {
      if (index !== current.fromIndex && current.centers[index] < draggedCenter) toIndex += 1;
    }
    setDrag({ ...current, dx, toIndex });
  };

  const onTabPointerUp = (id: string) => {
    if (pressRef.current?.id !== id) return;
    pressRef.current = null;
    if (drag !== null && drag.id === id) {
      // Commit, and swallow the click this pointerup is about to synthesise —
      // a drop must not double as an activate.
      suppressClickRef.current = true;
      if (drag.toIndex !== drag.fromIndex) onReorder(id, drag.toIndex);
      setDrag(null);
    }
  };

  const onTabPointerCancel = () => {
    pressRef.current = null;
    setDrag(null);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key === "F2") {
      const tab = tabs.find((entry) => entry.id === id);
      if (tab !== undefined) {
        event.preventDefault();
        startRename(tab);
      }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (!canClose) return;
      event.preventDefault();
      // Move focus onto the surviving neighbour (the reducer activates the
      // left one) before the closed button unmounts — otherwise focus falls
      // to <body> and the roving tabindex chain is lost.
      const index = tabs.findIndex((tab) => tab.id === id);
      const neighbour = tabs[index - 1] ?? tabs[index + 1];
      onClose(id);
      if (neighbour !== undefined) {
        document.getElementById(`explore-tab-${neighbour.id}`)?.focus();
      }
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd+Arrow MOVES the focused tab one slot (no wrap — the edges
      // are hard stops, unlike activation). Order is visual only, so nothing
      // is announced; focus must survive the move, though: React relocates
      // the keyed button in the DOM, which drops focus to <body>, so restore
      // it once the reorder has rendered — same pattern as endRename.
      const target = event.key === "ArrowLeft" ? index - 1 : index + 1;
      if (target < 0 || target >= tabs.length) return;
      onReorder(id, target);
      requestAnimationFrame(() => document.getElementById(`explore-tab-${id}`)?.focus());
      return;
    }
    const nextIndex =
      event.key === "ArrowLeft"
        ? (index - 1 + tabs.length) % tabs.length
        : (index + 1) % tabs.length;
    onActivate(tabs[nextIndex].id);
    document.getElementById(`explore-tab-${tabs[nextIndex].id}`)?.focus();
  };

  const onAuxClick = (event: MouseEvent<HTMLButtonElement>, id: string) => {
    // Middle-click closes, like a browser tab (QuixLake behavior).
    if (event.button === 1 && canClose) {
      event.preventDefault();
      onClose(id);
    }
  };

  const onMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    // Browsers start autoscroll on middle-button mousedown, before auxclick —
    // suppress it so a middle-click close never leaves the page panning.
    if (event.button === 1) event.preventDefault();
  };

  /* While a rename is in progress the strip drops its tablist/tab semantics —
     a tablist may only contain tabs (axe aria-required-children) and a tab may
     not contain a focusable input (axe nested-interactive). The keyboard
     belongs entirely to the input during the edit; roles return when it ends. */
  const renaming = editing !== null;

  return (
    <div className="flex flex-none items-center gap-1.5">
      <div
        role={renaming ? undefined : "tablist"}
        aria-label={renaming ? undefined : "Explore workbench tabs"}
        className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto rounded-md border border-line bg-surface shadow-tm"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const dragged = drag !== null && drag.id === tab.id;
          /* Drag choreography: the dragged tab tracks the pointer raw (no
             transition); every tab between its origin and its drop slot slides
             one tab-width the other way, transitioned. transform only — the
             DOM order changes exactly once, on drop. */
          let shift = 0;
          if (drag !== null && !dragged) {
            const step = drag.width + TAB_GAP_PX;
            if (drag.fromIndex < drag.toIndex && index > drag.fromIndex && index <= drag.toIndex) {
              shift = -step;
            } else if (
              drag.fromIndex > drag.toIndex &&
              index >= drag.toIndex &&
              index < drag.fromIndex
            ) {
              shift = step;
            }
          }
          const dragStyle =
            drag === null
              ? undefined
              : dragged
                ? { transform: `translateX(${drag.dx}px)`, zIndex: 1 }
                : { transform: `translateX(${shift}px)`, transition: "transform 150ms ease" };
          const tabClass = cn(
            "group relative flex h-[34px] max-w-[220px] flex-none items-center gap-2 border-r border-line-2 px-3 text-[0.78rem] whitespace-nowrap last:border-r-0",
            active
              ? "font-semibold text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary"
              : "font-medium text-ink-3 hover:bg-surface-2 hover:text-ink",
          );
          if (editing !== null && editing.id === tab.id) {
            // Inline rename: the tab swaps its <button> for a generic div
            // holding the input. No role="tab" while editing — an interactive
            // role must not contain a focusable descendant (axe
            // nested-interactive); the id stays so the pane's aria-labelledby
            // keeps resolving. Every key belongs to the input while it exists.
            return (
              <div
                key={tab.id}
                id={`explore-tab-${tab.id}`}
                className={tabClass}
              >
                <span className={cn(active && "text-primary")}>
                  <KindIcon kind={tab.kind} />
                </span>
                <input
                  aria-label="Rename tab"
                  autoFocus
                  maxLength={MAX_TAB_TITLE}
                  value={editing.draft}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setEditing({ id: tab.id, draft: event.target.value })}
                  onKeyDown={(event) => {
                    // Nothing leaks to the tablist or window shortcuts —
                    // Delete/Backspace must TYPE here, never close the tab.
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      endRename(true, true);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      endRename(false, true);
                    }
                  }}
                  onBlur={() => endRename(true, false)}
                  className="w-[110px] rounded-sm border border-line bg-surface px-1 py-px text-[0.78rem] text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>
            );
          }
          return (
            <button
              key={tab.id}
              type="button"
              role={renaming ? undefined : "tab"}
              id={`explore-tab-${tab.id}`}
              aria-selected={renaming ? undefined : active}
              aria-controls={renaming ? undefined : `explore-pane-${tab.id}`}
              tabIndex={active ? 0 : -1}
              title={tab.title}
              onClick={() => {
                // The click a completed drag synthesises is a drop, not a pick.
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onActivate(tab.id);
              }}
              onDoubleClick={() => startRename(tab)}
              onKeyDown={(event) => onTabKeyDown(event, tab.id)}
              onAuxClick={(event) => onAuxClick(event, tab.id)}
              onMouseDown={onMouseDown}
              onPointerDown={(event) => onTabPointerDown(event, tab.id)}
              onPointerMove={(event) => onTabPointerMove(event, tab.id)}
              onPointerUp={() => onTabPointerUp(tab.id)}
              onPointerCancel={onTabPointerCancel}
              style={dragStyle}
              className={tabClass}
            >
              <span className={cn(active && "text-primary")}>
                <KindIcon kind={tab.kind} />
              </span>
              <span className="overflow-hidden text-ellipsis">{tab.title}</span>
              {/* The × is aria-hidden (nested-interactive), so the keyboard
                  path — Delete on the focused tab — is stated in the tab's
                  own accessible name (FR-DM-090). */}
              {canClose && <span className="sr-only">— press Delete to close</span>}
              {canClose && (
                <span
                  aria-hidden
                  data-tab-close
                  title="Close tab (Delete)"
                  // Always visible — an appear-on-hover close made the strip
                  // flicker. Hover feedback stays on the × itself.
                  className="rounded-xs px-1 text-[0.8rem] leading-none text-ink-3 hover:bg-red-bg hover:text-red"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="New tab"
          title={atCap ? `Tab limit reached (${MAX_EXPLORE_TABS})` : "New tab"}
          className="grid size-[30px] flex-none place-items-center rounded-md border border-line bg-surface text-ink-2 transition-colors hover:border-accent-soft-border hover:text-primary disabled:opacity-50"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-44">
          <DropdownMenuItem disabled={atCap} onClick={() => onCreate("sql")}>
            <KindIcon kind="sql" /> SQL query
          </DropdownMenuItem>
          {aiAvailable && (
            <DropdownMenuItem disabled={atCap} onClick={() => onCreate("ai")}>
              <KindIcon kind="ai" /> Ask AI
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={atCap} onClick={() => onCreate("viz")}>
            <KindIcon kind="viz" /> Visualisation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="ml-auto flex flex-none items-center gap-[7px]">{children}</span>
    </div>
  );
});
