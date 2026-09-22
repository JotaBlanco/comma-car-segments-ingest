"use client";

/**
 * Schema rail — the queryable surface at a glance, click-to-insert.
 *
 * Docked at the ExploreTab host level on the LEFT, mirroring the History
 * panel's docking on the right (same card treatment: border, uppercase
 * header, close affordance) and spanning the full workbench height. It used
 * to live inside the SQL pane beside the editor, which cramped it to the
 * editor's height.
 *
 * The table name and column spellings are the PHYSICAL ones — the host
 * resolves the server-read `TM_LAKE_TABLE` through lib/explore/lake-schema.ts,
 * so the rail shows exactly the identifiers the lake reads (e.g. `ts_ms` /
 * `file_name` on `test_signal_samples_v3`); types are display hints from
 * lib/explore/schema.ts, keyed by those spellings. Signals come from the
 * shared run-signals fetch — when the run holds more than the page cap, the
 * rail says so instead of silently under-listing.
 *
 * Resize follows the editor splitter's accessibility shape exactly
 * (role="separator" + aria-value*, arrow keys, double-click reset).
 *
 * Section headers stick while their section scrolls. The TABLE bar carries
 * the table name; the SIGNALS bar carries the filter box. Each sticks only
 * inside its own section, so the next section pushes the previous bar away
 * and at most one bar is pinned over the list at a time.
 */

import { memo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { EXPLORE_COLUMN_TYPES } from "@/lib/explore/schema";
import { formatInt, formatRate } from "@/lib/format";
import type { FileSignal } from "@/types";

// Default bumped from 212 — signal names were truncating at the old width.
// Still user-resizable within the same bounds.
export const RAIL_DEFAULT = 250;
export const RAIL_MIN = 150;
export const RAIL_MAX = 420;

/** Above this many signals a filter box appears. */
const FILTER_THRESHOLD = 20;

export interface SchemaRailProps {
  table: string;
  columns: readonly string[];
  signals: readonly FileSignal[];
  signalTotal: number;
  width: number;
  onWidthChange: (width: number) => void;
  /** Insert a snippet at the active SQL tab's editor caret. */
  onInsert: (text: string) => void;
  onClose: () => void;
}

const itemClass =
  "flex w-full items-center gap-2 rounded-xs px-1.5 py-0.5 text-left font-mono text-[0.7rem] text-ink-2 transition-colors hover:bg-accent-soft hover:text-primary";

export const SchemaRail = memo(function SchemaRail({
  table,
  columns,
  signals,
  signalTotal,
  width,
  onWidthChange,
  onInsert,
  onClose,
}: SchemaRailProps) {
  const [filter, setFilter] = useState("");
  const dragRef = useRef<{ x: number; w: number } | null>(null);

  const clamp = (next: number) => Math.min(RAIL_MAX, Math.max(RAIL_MIN, next));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { x: event.clientX, w: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    onWidthChange(clamp(drag.w + (event.clientX - drag.x)));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 12;
    onWidthChange(clamp(width + (event.key === "ArrowRight" ? step : -step)));
  };

  const query = filter.trim().toLowerCase();
  const visible =
    query.length === 0
      ? signals
      : signals.filter((signal) => signal.name.toLowerCase().includes(query));

  return (
    <aside
      id="explore-schema"
      role="region"
      aria-label="Schema"
      className="flex min-h-0 flex-none overflow-hidden rounded-md border border-line bg-surface shadow-tm"
    >
      <div style={{ width }} className="flex min-h-0 flex-none flex-col overflow-hidden">
        <div className="flex flex-none items-center gap-2.5 border-b border-line-2 px-3.5 py-2">
          <span className="text-[0.72rem] font-bold tracking-[0.09em] uppercase">Schema</span>
          <span className="font-mono text-[0.66rem] text-ink-3">this run</span>
          <button
            type="button"
            aria-label="Close schema"
            onClick={onClose}
            className="ml-auto grid size-6 place-items-center rounded-md text-ink-3 transition-colors hover:bg-accent-soft hover:text-primary"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/*
          One scroll region, two sections. Each section header sticks inside
          its OWN wrapper div, so the signals section pushes the table header
          away as it arrives. The rail never stacks more than one pinned bar
          over the list. Sticky bars carry an opaque bg-surface and the same
          inset hairline as `.table-scroll thead th` in globals.css, because a
          plain border under a stuck header can vanish in some browsers.
          Rows carry scroll-mt-* so keyboard focus never lands hidden under a
          pinned bar. The container has no top padding of its own — each
          sticky bar owns its top gap, so rows cannot peek through above it.
        */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5">
          <div>
            <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-surface px-1.5 pt-2 pb-1 shadow-[inset_0_-1px_0_var(--line-2)]">
              <span className="flex-none text-[0.62rem] font-bold tracking-[0.09em] text-ink-3 uppercase">
                Table
              </span>
              <span className="overflow-hidden font-mono text-[0.7rem] font-semibold text-ellipsis whitespace-nowrap text-ink-2">
                {table}
              </span>
            </div>
            {columns.map((column) => (
              <button
                key={column}
                type="button"
                className={`${itemClass} scroll-mt-8`}
                onClick={() => onInsert(column)}
              >
                {column}
                <span className="ml-auto text-[0.6rem] text-ink-3">
                  {EXPLORE_COLUMN_TYPES[column]}
                </span>
              </button>
            ))}
          </div>

          <div>
            <div className="sticky top-0 z-10 bg-surface pt-2.5 pb-1 shadow-[inset_0_-1px_0_var(--line-2)]">
              <div className="px-1.5 pb-1 text-[0.62rem] font-bold tracking-[0.09em] text-ink-3 uppercase">
                Signals in this run
              </div>
              {signals.length > FILTER_THRESHOLD && (
                <input
                  type="search"
                  aria-label="Filter signals"
                  placeholder="Filter signals…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  className="h-6 w-full rounded-sm border border-line bg-surface px-1.5 text-[0.7rem] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              )}
            </div>
            {visible.map((signal) => (
              <button
                key={signal.name}
                type="button"
                className={`${itemClass} scroll-mt-16`}
                // Signals are VALUES of the signal column — insert quoted.
                onClick={() => onInsert(`'${signal.name.replaceAll("'", "''")}'`)}
              >
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{signal.name}</span>
                <span className="ml-auto flex-none text-[0.6rem] text-ink-3">
                  {formatRate(signal.rate_hz)} Hz
                </span>
              </button>
            ))}
            {signals.length < signalTotal && (
              <div className="px-1.5 pt-1 text-[0.66rem] text-ink-3">
                Showing {formatInt(signals.length)} of {formatInt(signalTotal)} signals.
              </div>
            )}
          </div>
        </div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize schema panel"
        aria-valuemin={RAIL_MIN}
        aria-valuemax={RAIL_MAX}
        aria-valuenow={Math.round(width)}
        title="Drag to resize · double-click to reset"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => onWidthChange(RAIL_DEFAULT)}
        onKeyDown={onKeyDown}
        className="group grid w-[9px] flex-none cursor-col-resize touch-none place-items-center border-l border-line-2 bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="h-[34px] w-[3px] rounded-full bg-line-strong opacity-70 transition-colors group-hover:bg-primary group-hover:opacity-100" />
      </div>
    </aside>
  );
});
