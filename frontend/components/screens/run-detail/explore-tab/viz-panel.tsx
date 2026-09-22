"use client";

/**
 * Visualise mode (plan §4, D-E2) — Chart.js 4 line chart, styled to match the
 * approved mockup exactly via lib/charts/tm-chart-theme.ts.
 *
 * This module is only ever loaded through next/dynamic (ssr: false) from
 * explore-tab.tsx, so Chart.js stays out of the base run-detail chunk.
 *
 * Signal chips (any number of series — colors come from tmSeriesColors, which
 * generates a theme-aware distinct palette past the 4 branded tokens),
 * aggregate + bucket selects; the FE builds
 * time_bucket SQL and executes it through the same lake query mutation as
 * the SQL mode. chartjs-plugin-zoom drag-zoom narrows the time range and
 * re-queries at the new bucket width (~1 point per device pixel).
 */

import Chart from "chart.js/auto";
import zoomPlugin from "chartjs-plugin-zoom";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { Panel } from "@/components/shared/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { cssVar, tmChartConfig, tmSeriesColors, type TmPoint, type TmSeries } from "@/lib/charts/tm-chart-theme";
import type { LakeSchema } from "@/lib/explore/lake-schema";
import { MAX_EXPLORE_TABS } from "@/lib/explore/tabs";
import { bucketLabel, buildVizSql, computeBucketMs, type VizAggregate } from "@/lib/explore/viz-sql";
import { formatInt } from "@/lib/format";
import { useExploreQuery, useRun } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { highlightSql } from "./sql-editor";

Chart.register(zoomPlugin);

const AGGREGATES: readonly VizAggregate[] = ["avg", "min", "max"];

/** Narrowest window a drag may select — about 100 points at the 10 ms bucket floor. */
const MIN_ZOOM_MS = 1_000;

/** A drag shorter than this is a click, not a zoom. */
const DRAG_THRESHOLD_PX = 6;

/**
 * Container width is quantised before it reaches the bucket maths. The chart
 * lives inside the element the ResizeObserver watches, so a rebuild resizes the
 * canvas, which re-fires the observer: without this, a one-pixel wobble (a
 * legend gaining a scrollbar, say) re-enters width → bucket → SQL → query →
 * rebuild and fires a fresh lake query every lap.
 */
const WIDTH_QUANTUM_PX = 50;

/** Direct-label shorthand, e.g. brake_temp_FL → FL. */
function shortName(name: string): string {
  const parts = name.split("_");
  const last = parts[parts.length - 1];
  return last.length <= 4 ? last : name.slice(0, 3);
}

const controlClass =
  "h-7 rounded-md border border-line bg-surface px-2 text-[0.74rem] font-medium text-ink-2";

interface VizPanelProps {
  runId: string;
  signalNames: string[];
  /** The PHYSICAL lake schema (server-read `TM_LAKE_TABLE`, resolved by
   *  lib/explore/lake-schema.ts) — the exact spellings the lake receives. */
  schema: LakeSchema;
  /** Hand the chart's generated SQL to a fresh SQL tab (never auto-run). */
  onOpenInSql?: (sql: string) => void;
  /** At the workbench tab cap a create is refused — disable instead of no-op. */
  openInSqlDisabled?: boolean;
}

export function VizPanel({
  runId,
  signalNames,
  schema,
  onOpenInSql,
  openInSqlDisabled = false,
}: VizPanelProps) {
  const runQuery = useRun(runId);
  const query = useExploreQuery();
  const { mutate } = query;

  /** Signals the user explicitly picked; null = default to the first two. */
  const [userSelected, setUserSelected] = useState<string[] | null>(null);
  const [aggregate, setAggregate] = useState<VizAggregate>("avg");
  /** Narrowed window from drag-zoom; null = the whole run. */
  const [zoomRange, setZoomRange] = useState<{ from: string; to: string } | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [containerPx, setContainerPx] = useState(720);
  /** The collapsible "SQL this chart runs" strip; collapsed by default. */
  const [sqlOpen, setSqlOpen] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  /** Re-entrancy latch for onZoomComplete — see the note on that callback. */
  const zoomingRef = useRef(false);

  // Derived, join-keyed so effects only re-run when the selection changes.
  // (Signal names cannot contain a newline.)
  const signalsKey = signalNames.join("\n");
  const selected = useMemo(() => {
    if (userSelected !== null) return userSelected;
    const names = signalsKey.length === 0 ? [] : signalsKey.split("\n");
    return names.slice(0, 2);
  }, [userSelected, signalsKey]);
  const selectedKey = selected.join("\n");

  // Container width for the ~1-point-per-pixel bucket maths — measured via
  // ResizeObserver (its callback also fires once on observe).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined || width <= 0) return;
      const next = Math.max(
        WIDTH_QUANTUM_PX,
        Math.round(width / WIDTH_QUANTUM_PX) * WIDTH_QUANTUM_PX,
      );
      // The equality bail-out is what severs the resize/rebuild loop: React
      // skips the re-render when the quantised width has not moved.
      setContainerPx((previous) => (previous === next ? previous : next));
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const run = runQuery.data;
  const timeFrom = zoomRange?.from ?? run?.started_at;
  const timeTo = zoomRange?.to ?? run?.ended_at;
  const rangeMs =
    timeFrom != null && timeTo != null ? Date.parse(timeTo) - Date.parse(timeFrom) : 0;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const bucketMs = rangeMs > 0 ? computeBucketMs(rangeMs, containerPx, dpr) : 1000;

  const sql =
    selected.length > 0 && rangeMs > 0
      ? buildVizSql({
          signals: selected,
          aggregate,
          bucketMs,
          runId,
          timeFrom: zoomRange?.from,
          timeTo: zoomRange?.to,
        }, schema)
      : null;

  // Re-query whenever the built SQL changes (signals, aggregate, zoom window).
  useEffect(() => {
    if (sql === null) return;
    mutate({ sql });
  }, [sql, mutate]);

  // Rebuild the chart on theme change — the config reads tokens at build time.
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((tick) => tick + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const result = query.data;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || result === undefined) return;
    const selectedNames = selectedKey.length === 0 ? [] : selectedKey.split("\n");

    const pointsBySignal = new Map<string, TmPoint[]>();
    for (const row of result.rows) {
      const [name, ts, value] = row;
      // The viz SQL serves `ts` as epoch milliseconds (buildVizSql wraps the
      // bucket in epoch_ms); Date.parse stays as the fallback for a lake that
      // answers a timestamp string instead of a number.
      const x = /^\d+$/.test(ts) ? Number(ts) : Date.parse(ts);
      const y = Number(value);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const list = pointsBySignal.get(name) ?? [];
      list.push({ x, y });
      pointsBySignal.set(name, list);
    }

    const colors = tmSeriesColors(selectedNames.length);
    const series: TmSeries[] = selectedNames
      .map((name, index) => ({
        label: name,
        short: shortName(name),
        color: colors[index],
        points: pointsBySignal.get(name) ?? [],
      }))
      .filter((entry) => entry.points.length > 0);

    const config = tmChartConfig(series);
    const options = config.options ?? {};
    options.plugins = {
      ...options.plugins,
      zoom: {
        // `limits` stops a stray flick of the mouse from selecting a window so
        // narrow that the scale bounds go degenerate; `threshold` means an
        // accidental click-drag never costs a lake query.
        limits: { x: { minRange: MIN_ZOOM_MS } },
        zoom: {
          drag: { enabled: true, backgroundColor: cssVar("--accent-soft"), threshold: DRAG_THRESHOLD_PX },
          mode: "x",
          // NEVER call chart.resetZoom() from here. The plugin fires
          // onZoomComplete from inside resetZoom itself (chartjs-plugin-zoom
          // 2.2.0, dist/chartjs-plugin-zoom.esm.js:388), so the pair recurses
          // without bound — synchronously, inside the mouseup handler, running
          // a full chart.update() every lap. That froze the tab.
          //
          // No reset is needed: the re-query below lands new data, and the
          // effect that owns this config destroys the chart and builds a fresh
          // one whose x scale auto-ranges over the narrowed window. Until then
          // the plugin's own zoomed view is the right thing to show.
          onZoomComplete: ({ chart }) => {
            if (zoomingRef.current) return;
            const scale = chart.scales.x;
            if (scale === undefined) return;
            // A degenerate drag leaves these NaN, and new Date(NaN).toISOString()
            // throws a RangeError inside the plugin's own callback.
            if (!Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
            zoomingRef.current = true;
            try {
              setZoomRange({
                from: new Date(scale.min).toISOString(),
                to: new Date(scale.max).toISOString(),
              });
            } finally {
              zoomingRef.current = false;
            }
          },
        },
      },
    };
    config.options = options;

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, config);
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [result, selectedKey, themeTick]);

  const available = signalNames.filter((name) => !selected.includes(name));
  // Same generated colors as the chart lines, inline-styled onto the chips and
  // the HTML legend so swatches always match. Recomputed on theme change via
  // the themeTick re-render (the same MutationObserver that rebuilds the chart).
  const seriesColors = tmSeriesColors(selected.length);
  const error = query.error;
  const errorMessage =
    error instanceof ApiError && error.code === "lake_unavailable"
      ? "Lake unreachable — Explore queries run in the deployed environment."
      : error instanceof ApiError
        ? error.detail
        : error !== null
          ? "Could not run this query."
          : null;

  return (
    <Panel className="flex h-full min-h-0 flex-col">
      {/* The query behind the chart, on demand — the chart never runs SQL the
          user cannot see. QuixLake's bar only offers Copy; this one can also
          hand the statement to a SQL tab. */}
      <div className="flex-none border-b border-line-2 bg-surface-2">
        <div className="flex items-center gap-2 px-3.5 py-1.5">
          <button
            type="button"
            aria-expanded={sqlOpen}
            aria-controls="viz-sql-peek"
            onClick={() => setSqlOpen((open) => !open)}
            className="flex items-center gap-2 text-[0.74rem] text-ink-3 transition-colors hover:text-ink"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              aria-hidden
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={cn("transition-transform", sqlOpen && "rotate-90")}
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
            <b className="text-[0.68rem] tracking-[0.06em] text-ink">SQL</b>
            the query this chart runs
          </button>
          {sqlOpen && sql !== null && (
            <span className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                className="rounded-xs px-1.5 py-0.5 text-[0.68rem] text-ink-3 transition-colors hover:bg-accent-soft hover:text-primary"
                onClick={() => {
                  // Clipboard unavailable — the try/catch takes the sync
                  // throw, the .catch the async denial.
                  try {
                    navigator.clipboard.writeText(sql).catch(() => {});
                  } catch {
                    // ignore
                  }
                }}
              >
                Copy
              </button>
              {onOpenInSql !== undefined && (
                <button
                  type="button"
                  className="rounded-xs px-1.5 py-0.5 text-[0.68rem] font-semibold text-primary transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  disabled={openInSqlDisabled}
                  // Same gate + wording as the tab strip's "+" menu.
                  title={openInSqlDisabled ? `Tab limit reached (${MAX_EXPLORE_TABS})` : undefined}
                  onClick={() => onOpenInSql(sql)}
                >
                  Open in SQL tab
                </button>
              )}
            </span>
          )}
        </div>
        {sqlOpen && (
          <pre
            id="viz-sql-peek"
            className="overflow-x-auto px-4 pt-0.5 pb-2.5 font-mono text-[0.72rem] leading-[1.65] whitespace-pre text-ink"
          >
            {sql !== null ? highlightSql(sql) : "-- Pick at least one signal to build a query."}
          </pre>
        )}
      </div>

      {/* Two zones: the chips area wraps freely; the chart controls are a
          non-shrinking group pinned right that never wraps or gets pushed. */}
      <div className="flex flex-none items-start gap-3 border-b border-line-2 px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="mr-0.5 text-[0.65rem] font-semibold tracking-[0.08em] text-ink-3 uppercase">
          Signals
        </span>
        {selected.map((name, index) => (
          <span
            key={name}
            className="inline-flex items-center gap-[7px] rounded-sm border border-line bg-surface px-2 py-[3px] font-mono text-[0.7rem]"
          >
            <span
              aria-hidden
              className="size-[9px] rounded-[2px]"
              style={{ background: seriesColors[index] }}
            />
            {name}
            <button
              type="button"
              aria-label={`Remove ${name}`}
              className="px-px text-[0.8rem] leading-none text-ink-3 hover:text-red"
              onClick={() => setUserSelected(selected.filter((entry) => entry !== name))}
            >
              ×
            </button>
          </span>
        ))}
        <select
          aria-label="Add signal"
          className={controlClass}
          value=""
          disabled={available.length === 0}
          onChange={(event) => {
            const name = event.target.value;
            if (name.length === 0) return;
            // The only ceiling is the run itself — every signal at most once.
            if (!selected.includes(name)) {
              setUserSelected([...selected, name]);
            }
          }}
        >
          <option value="">+ Add signal</option>
          {available.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        </div>
        <div className="flex flex-none items-center gap-2">
        <label className="inline-flex items-center gap-1.5 text-[0.65rem] font-semibold tracking-[0.08em] text-ink-3 uppercase">
          Aggregate
          <select
            aria-label="Aggregate"
            className={controlClass}
            value={aggregate}
            onChange={(event) => setAggregate(event.target.value as VizAggregate)}
          >
            {AGGREGATES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5 text-[0.65rem] font-semibold tracking-[0.08em] text-ink-3 uppercase">
          Bucket
          <select aria-label="Bucket" className={controlClass} value="auto" onChange={() => undefined}>
            <option value="auto">auto · {bucketLabel(bucketMs)}</option>
          </select>
        </label>
        {/* WCAG 2.1.1 scoping note (FR-DM-090): the drag-zoom gesture has no
            keyboard equivalent this slice, and that is a documented, scoped
            exception — every data point the chart draws is also reachable
            through the keyboard-accessible results table (Table pane / SQL
            results), so only the zoom GESTURE is pointer-only, never any
            information or function. This keyboard-reachable Reset button is
            the compensating control that undoes a pointer zoom. Keyboard-
            driven zoom is a recorded non-goal — see
            docs/VOICEOVER-VALIDATION.md, "Agreed exemptions". */}
        <button
          type="button"
          className="h-7 rounded-md border border-line bg-surface px-2.5 text-[0.74rem] font-semibold text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
          disabled={zoomRange === null}
          onClick={() => setZoomRange(null)}
        >
          Reset zoom
        </button>
        </div>
      </div>

      <div ref={wrapRef} className="relative flex min-h-0 flex-1 flex-col px-1 pt-4 pb-1.5">
        {selected.length > 0 && (
          <div
            role="list"
            aria-label="Series"
            className="absolute top-[18px] right-[22px] z-[1] flex max-h-[38%] max-w-[calc(100%-44px)] flex-wrap justify-end gap-x-3.5 gap-y-1 overflow-y-auto rounded-sm bg-surface/80 px-2 py-[3px] text-[0.7rem] text-ink-2"
          >
            {selected.map((name, index) => (
              <span role="listitem" key={name} className="whitespace-nowrap">
                <span
                  aria-hidden
                  className="mr-[5px] inline-block size-2.5 -translate-y-px rounded-[2px] align-middle"
                  style={{ background: seriesColors[index] }}
                />
                {name}
              </span>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 px-1.5">
          {errorMessage !== null ? (
            <ErrorState
              message={errorMessage}
              onRetry={() => {
                if (sql !== null) mutate({ sql });
              }}
              className="pt-24"
            />
          ) : result === undefined ? (
            <div className="flex h-full flex-col justify-center gap-3 px-6">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-5/6" />
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={`${selected.join(", ")} over the run — ${aggregate} per ${bucketLabel(bucketMs)} bucket`}
            />
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-line-2 bg-surface-2 px-4 py-[9px] text-[0.72rem] text-ink-3">
        {result !== undefined && selected.length > 0 ? (
          <>
            {formatInt(Math.ceil(result.row_count / selected.length))} buckets — ~1 point per pixel
            · drag to zoom, the query re-runs at the new bucket width
          </>
        ) : (
          <>Aggregated lakeside with time_bucket — nothing is precomputed off-lake.</>
        )}
      </div>
    </Panel>
  );
}
