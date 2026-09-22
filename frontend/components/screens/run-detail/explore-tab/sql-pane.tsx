"use client";

/**
 * One SQL workbench tab: editor / splitter / results. (The schema rail is a
 * host-level docked panel in explore-tab.tsx, like the history panel.)
 *
 * Extracted from explore-tab.tsx when the mode segment became a tab strip.
 * Each pane owns its own useExploreQuery mutation, so every tab keeps its own
 * results, error and timing without a shared store. History records here — in
 * the explicit run handler — and nowhere else, so viz requeries and AI tool
 * runs never spam the log. Timing wraps the whole request client-side; the
 * API's elapsed_ms is the lake round-trip, and the difference is labeled
 * transfer because that is what it mostly is.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { ApiError } from "@/lib/api/client";
import { recordExploreHistory } from "@/lib/explore/history-store";
import type { SqlSnippet } from "@/lib/explore/viz-sql";
import { useAnnounce, useExploreQuery } from "@/lib/hooks";
import { ResultsPanel, type ResultsTiming } from "./results-panel";
import { SqlEditor, type SqlEditorHandle } from "./sql-editor";

/** Resizable editor pane geometry (px), mirroring the approved mockup. */
export const EDITOR_DEFAULT = 212;
export const EDITOR_MIN = 96;
/** Space kept below the splitter so the results pane stays usable. */
export const RESULTS_MIN = 170;

export interface SqlPaneProps {
  runId: string;
  sql: string;
  onSqlChange: (sql: string) => void;
  snippets: SqlSnippet[];
  /**
   * Out-ref for this pane's editor handle — the host wires it to the docked
   * schema rail so click-to-insert targets the ACTIVE SQL tab's caret.
   */
  editorHandle?: { current: SqlEditorHandle | null };
  editorHeight: number;
  onEditorHeightChange: (height: number) => void;
  /** Completion vocabulary, threaded through to the editor. */
  table: string;
  columns: readonly string[];
  signalNames: readonly string[];
}

export const SqlPane = memo(function SqlPane({
  runId,
  sql,
  onSqlChange,
  snippets,
  editorHandle,
  editorHeight,
  onEditorHeightChange,
  table,
  columns,
  signalNames,
}: SqlPaneProps) {
  const queryMutation = useExploreQuery();
  const [timing, setTiming] = useState<ResultsTiming | null>(null);
  /* A finished query redraws the results pane silently — say the outcome
     through the shared polite region (FR-DM-091). */
  const announce = useAnnounce();

  const { mutateAsync, isPending } = queryMutation;
  const runQuery = useCallback(() => {
    // Cmd+Enter in the editor is not gated by the button's disabled state.
    // An empty editor (fresh tab showing its placeholder) never sends a query.
    if (isPending || sql.trim().length === 0) return;
    const startedAt = performance.now();
    setTiming(null);
    mutateAsync({ sql })
      .then((result) => {
        const totalMs = performance.now() - startedAt;
        setTiming({ totalMs, lakeMs: result.elapsed_ms });
        announce(
          `Query complete — ${result.row_count} ${result.row_count === 1 ? "row" : "rows"}${result.truncated ? ", truncated" : ""}`
        );
        recordExploreHistory(runId, {
          sql,
          at: Date.now(),
          status: "ok",
          rowCount: result.row_count,
          truncated: result.truncated,
          lakeMs: result.elapsed_ms,
          totalMs,
        });
      })
      .catch((error: unknown) => {
        announce("Query failed");
        recordExploreHistory(runId, {
          sql,
          at: Date.now(),
          status: "error",
          detail: error instanceof ApiError ? error.detail : undefined,
        });
      });
  }, [announce, isPending, mutateAsync, runId, sql]);

  /* Every failure is one kind now. The guarded backend path and its 400
     sql_rejected are gone — nothing emits that code any more — so a DuckDB
     error (400 lake_query_error, e.g. a typo'd column) correctly lands in
     the results panel's error state below, with its detail and a retry. */
  const queryError = queryMutation.error;

  // Editor/results splitter — geometry state lives in explore-tab so every
  // SQL tab shares one layout; the clamp needs this pane's own container.
  const splitRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ y: number; h: number } | null>(null);

  const clampHeight = useCallback((height: number) => {
    const container = splitRef.current;
    const maxHeight = container
      ? container.getBoundingClientRect().height - RESULTS_MIN
      : Number.POSITIVE_INFINITY;
    return Math.min(Math.max(EDITOR_MIN, maxHeight), Math.max(EDITOR_MIN, height));
  }, []);

  // The splitter's aria-valuemax mirrors clampHeight's ceiling (container
  // height minus the results floor), tracked via ResizeObserver like the
  // schema rail keeps its separator attributes truthful.
  const [maxEditorHeight, setMaxEditorHeight] = useState<number | null>(null);
  useEffect(() => {
    const container = splitRef.current;
    // jsdom has no ResizeObserver — the attribute then keeps its fallback.
    if (container === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const ceiling = container.getBoundingClientRect().height - RESULTS_MIN;
      setMaxEditorHeight(Math.round(Math.max(EDITOR_MIN, ceiling)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const onSplitterDown = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { y: event.clientY, h: editorHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onSplitterMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    onEditorHeightChange(clampHeight(drag.h + (event.clientY - drag.y)));
  };
  const onSplitterUp = () => {
    dragRef.current = null;
  };
  const onSplitterKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 12;
    onEditorHeightChange(clampHeight(editorHeight + (event.key === "ArrowDown" ? step : -step)));
  };

  return (
    <div ref={splitRef} className="flex h-full min-h-0 flex-col">
      <div style={{ height: editorHeight }} className="flex min-h-0 flex-none overflow-hidden">
        <div className="min-w-0 flex-1">
          <SqlEditor
            value={sql}
            onChange={onSqlChange}
            onRun={runQuery}
            running={queryMutation.isPending}
            snippets={snippets}
            handleRef={editorHandle}
            table={table}
            columns={columns}
            signals={signalNames}
          />
        </div>
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor and results"
        aria-valuemin={EDITOR_MIN}
        aria-valuemax={maxEditorHeight ?? Math.round(Math.max(EDITOR_MIN, editorHeight))}
        aria-valuenow={Math.round(editorHeight)}
        title="Drag to resize · double-click to reset"
        tabIndex={0}
        onPointerDown={onSplitterDown}
        onPointerMove={onSplitterMove}
        onPointerUp={onSplitterUp}
        onPointerCancel={onSplitterUp}
        onDoubleClick={() => onEditorHeightChange(EDITOR_DEFAULT)}
        onKeyDown={onSplitterKey}
        className="group grid h-[9px] flex-none cursor-row-resize touch-none place-items-center border-y border-line-2 bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="h-[3px] w-[34px] rounded-full bg-line-strong opacity-70 transition-colors group-hover:bg-primary group-hover:opacity-100" />
      </div>
      <div className="min-h-0 flex-1">
        <ResultsPanel
          runId={runId}
          result={queryMutation.data}
          error={queryError}
          isPending={queryMutation.isPending}
          onRetry={runQuery}
          timing={timing}
          fill
        />
      </div>
    </div>
  );
});
