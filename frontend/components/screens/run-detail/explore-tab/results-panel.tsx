"use client";

/**
 * Explore query results (plan §4).
 *
 * - Panel + TableScrollArea → sticky header while rows scroll.
 * - Counts/timings via lib/format (en-GB); empty cells render "—"
 *   (the NO_STAT convention) — never fake zeros.
 * - Download CSV builds a client-side blob from the already-delivered rows
 *   (D-E5: no server round-trip, no journal entry).
 * - 503 lake_unavailable renders the ErrorState-based panel modelled on the
 *   download-button's 503 branch. Every other error surfaces its `detail`
 *   here — including a DuckDB error (400 lake_query_error): the SQL reaches
 *   the lake verbatim, so the lake's own refusal is a query outcome and this
 *   panel is where query outcomes land.
 */

import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { Panel, PanelHead, TableScrollArea } from "@/components/shared/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api/client";
import { toCsv } from "@/lib/explore/csv";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ExploreQueryResult } from "@/types";

const NO_STAT = "—";

function formatElapsed(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} s lakeside`;
}

/** Trigger a browser download of the result as CSV (client-side blob). */
function downloadCsv(result: ExploreQueryResult, runId: string): void {
  const blob = new Blob([toCsv(result.columns, result.rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${runId}-explore.csv`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A column is right-aligned when every non-empty cell parses as a number. */
function numericColumns(result: ExploreQueryResult): boolean[] {
  return result.columns.map((_, columnIndex) => {
    let sawValue = false;
    for (const row of result.rows) {
      const cell = row[columnIndex];
      if (cell === undefined || cell === null || cell === "") continue;
      sawValue = true;
      if (!Number.isFinite(Number(cell))) return false;
    }
    return sawValue;
  });
}

export interface ResultsTiming {
  /** Wall clock around the whole request, measured client-side. */
  totalMs: number;
  /** Lake round-trip reported by the API (elapsed_ms). */
  lakeMs: number;
}

interface ResultsPanelProps {
  runId: string;
  result: ExploreQueryResult | undefined;
  /** Any error from the query mutation — DuckDB refusals included. */
  error: unknown;
  isPending: boolean;
  onRetry: () => void;
  /**
   * Fill the parent's height (Explore focus layout): the Panel becomes a flex
   * column and the results scroll internally with no fixed cap. Off by default
   * so the Panel keeps its intrinsic height elsewhere.
   */
  fill?: boolean;
  /**
   * Last run's timing for the footer strip. "transfer" is total − lake — the
   * proxy hop plus network, never labeled as app work.
   */
  timing?: ResultsTiming | null;
}

export function ResultsPanel({
  runId,
  result,
  error,
  isPending,
  onRetry,
  fill = false,
  timing = null,
}: ResultsPanelProps) {
  const panelClass = fill ? "flex h-full min-h-0 flex-col" : undefined;

  if (isPending) {
    return (
      <Panel className={panelClass}>
        <PanelHead title="Results" />
        <Table>
          <TableBody>
            <LoadingRows rows={6} cols={3} />
          </TableBody>
        </Table>
      </Panel>
    );
  }

  if (error !== null && error !== undefined) {
    const lakeDown = error instanceof ApiError && error.code === "lake_unavailable";
    const message = lakeDown
      ? "Lake unreachable — Explore queries run in the deployed environment."
      : error instanceof ApiError
        ? error.detail
        : "Could not run this query.";
    return (
      <Panel className={panelClass}>
        <PanelHead title="Results" />
        <ErrorState message={message} onRetry={onRetry} />
      </Panel>
    );
  }

  if (result === undefined) {
    return (
      <Panel className={panelClass}>
        <PanelHead title="Results" />
        <EmptyState
          title="No query run yet"
          message="Run the query above — DuckDB executes it inside the lake, scoped to this run."
        />
      </Panel>
    );
  }

  const numeric = numericColumns(result);

  return (
    <Panel className={panelClass}>
      <PanelHead
        title="Results"
        action={
          <span className="inline-flex items-center gap-2.5">
            <span className="font-mono text-[0.7rem] text-ink-3">
              {formatInt(result.row_count)} rows
              {result.truncated && " (truncated)"} · {formatElapsed(result.elapsed_ms)}
            </span>
            <button
              type="button"
              className="rounded-md border border-line bg-surface px-2.5 py-1 text-[0.72rem] font-semibold text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
              onClick={() => downloadCsv(result, runId)}
            >
              Download CSV
            </button>
          </span>
        }
      />
      <TableScrollArea className={cn(!fill && "max-h-[420px]")}>
        <Table aria-label="Query results">
          <TableHeader>
            <TableRow>
              {result.columns.map((column, columnIndex) => (
                <TableHead key={column.name} className={cn(numeric[columnIndex] && "text-right!")}>
                  {column.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={Math.max(1, result.columns.length)} className="p-0!">
                  <EmptyState title="No rows" message="The query matched no samples in this run." />
                </TableCell>
              </TableRow>
            )}
            {result.rows.map((row, rowIndex) => (
              <TableRow key={rowIndex}>
                {result.columns.map((column, columnIndex) => {
                  const cell = row[columnIndex];
                  const empty = cell === undefined || cell === null || cell === "";
                  return (
                    <TableCell
                      key={column.name}
                      className={cn(
                        "font-mono text-[0.74rem]",
                        numeric[columnIndex] && "text-right",
                        empty && "text-ink-3",
                      )}
                    >
                      {empty ? NO_STAT : cell}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScrollArea>
      <div className="flex flex-wrap items-center gap-x-2 border-t border-line-2 bg-surface-2 px-4 py-[9px] text-[0.72rem] text-ink-3">
        {timing !== null && (
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-[7px] rounded-full bg-green-dot" />
            Query completed ·{" "}
            <b className="font-mono text-[0.7rem] font-semibold text-ink">
              {formatInt(Math.round(timing.totalMs))} ms end-to-end
            </b>
            <span className="font-mono text-[0.68rem]">
              ({formatInt(Math.round(timing.lakeMs))} ms in lake ·{" "}
              {formatInt(Math.max(0, Math.round(timing.totalMs - timing.lakeMs)))} ms transfer)
            </span>
            <span aria-hidden>·</span>
          </span>
        )}
        DuckDB runs the query inside the lake, over this run&apos;s Parquet only.
      </div>
    </Panel>
  );
}
