"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { AlertTriangle, ChevronDown, ExternalLink, Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { VerdictCounts } from "@/components/v-model/results/verdict-badge"
import { RunCaseList } from "./run-case-list"
import {
  formatSuccessRate,
  formatUtc,
} from "@/components/v-model/results/verdict"
import { RunStatusBadge } from "@/components/v-model/run-status-badge"
import { RunTestRunButton } from "@/components/v-model/run-test-run-button"
import { useVariant } from "@/lib/contexts/variant-context"
import { cn } from "@/lib/utils"
import type { RunSummary } from "@/types/vmodel"
import { useRunDetail } from "./use-run-detail"

interface RunDetailPanelProps {
  /** The `?select=` target. Null renders the "pick a run" placeholder. */
  runId: string | null
  /** Called after the run changes state, so the page can refetch its list. */
  onRunChanged: (run: RunSummary) => void
}

/** Verdict sort order: failures surface to the top in showcase mode. */
const VERDICT_SORT: Record<string, number> = {
  FAIL: 0,
  INCONCLUSIVE: 1,
  NOT_RUN: 2,
  PASS: 3,
}

/**
 * Region C of the Test Run explorer: what the selected run contains and whether
 * it passed.
 *
 * Default layout: one-column, metadata grid, stat boxes — the engineer view.
 * Showcase layout: donut rings for headline numbers, metadata collapsed behind
 * a toggle, failures sorted first — the demo view for a non-technical audience.
 */
export function RunDetailPanel({ runId, onRunChanged }: RunDetailPanelProps) {
  const { variant } = useVariant()
  const { summary, rows, loading, error, refetch } = useRunDetail(runId)
  // Showcase collapses run metadata by default so the verdict is the first thing seen.
  const [metaOpen, setMetaOpen] = useState(false)
  // Editorial segments the panel into Cases / Metrics / Details tabs.
  const [editorialTab, setEditorialTab] = useState<"cases" | "metrics" | "details">("cases")

  // Sort: failures first in showcase, id order in default.
  const sortedRows = useMemo(() => {
    if (variant !== "showcase") return rows
    return [...rows].sort(
      (a, b) => (VERDICT_SORT[a.status] ?? 2) - (VERDICT_SORT[b.status] ?? 2)
    )
  }, [rows, variant])

  if (!runId) {
    return (
      <Placeholder
        title="No run selected"
        body="Pick a run on the left to see its test cases and their verdicts. Add Test Run creates a new one."
      />
    )
  }

  if (loading && !summary) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading {runId}&hellip;
      </div>
    )
  }

  if (error || !summary) {
    return (
      <div className="space-y-2 p-6 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {runId} could not be loaded
        </p>
        <p className="text-muted-foreground">
          {error ? error.message : "The backend returned no summary for this run."}
        </p>
        <p className="text-xs text-muted-foreground">
          GET /api/v1/vmodel/runs/{runId}/summary did not return a result.
        </p>
      </div>
    )
  }

  const { run, coverage } = summary
  const planned = summary.test_cases.length
  const evaluated = summary.test_cases.filter((item) => item.status !== "NOT_RUN").length

  // ── Showcase layout ───────────────────────────────────────────────────────
  // Verdict → donut numbers → cases (failures first). Everything else behind a link.
  if (variant === "showcase") {
    return (
      <div className="space-y-6 p-5 lg:p-8">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-mono text-xl font-semibold">{run.run_id}</h2>
            <RunStatusBadge status={run.status} />
            {(run.status === "planned" || run.status === "running") && (
              <Badge variant="outline">{run.origin}</Badge>
            )}
            {run.baseline_id && (
              <Badge variant="secondary">baseline {run.baseline_id}</Badge>
            )}
            <div className="ml-auto flex items-center gap-3">
              {run.origin === "planned" && (
                <RunTestRunButton
                  runId={run.run_id}
                  status={run.status}
                  plannedTcIds={run.planned_tc_ids}
                  onStatusChange={(updated) => {
                    onRunChanged(updated)
                    refetch()
                  }}
                />
              )}
              <Link
                href={`/test-results/${encodeURIComponent(run.run_id)}`}
                className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                Full report
              </Link>
            </div>
          </div>

          {run.label && (
            <p className="text-base text-muted-foreground">{run.label}</p>
          )}

          {/* Metadata collapsed — the audience wants the verdict, not timestamps. */}
          <button
            type="button"
            onClick={() => setMetaOpen((prev) => !prev)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", metaOpen && "rotate-180")}
              aria-hidden="true"
            />
            {metaOpen ? "Hide details" : "Run details"}
          </button>

          {metaOpen && (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Scenario" value={run.scenario ?? "not set"} />
              <Field label="Created" value={formatUtc(run.created_utc) ?? "—"} />
              <Field label="Started" value={formatUtc(run.started_utc) ?? "not started"} />
              <Field label="Evaluated" value={formatUtc(run.evaluated_utc) ?? "not evaluated"} />
              <Field label="Planned cases" value={String(planned)} />
              <Field label="Traces" value={String(run.trace_keys.length)} />
            </dl>
          )}
        </div>

        {/* Donut rings — verdict → number → picture, in that order of legibility. */}
        <div className="flex flex-wrap justify-around gap-6 py-4">
          <DonutStat
            pct={run.success_rate}
            label="Success rate"
            colorClass={
              (run.success_rate ?? 0) >= 100
                ? "text-neon-pass"
                : (run.success_rate ?? 0) > 0
                ? "text-neon-warn"
                : "text-neon-fail"
            }
            sub={
              evaluated === 0
                ? "not evaluated"
                : `${run.tc_counts.PASS ?? 0} of ${evaluated} passed`
            }
          />
          <DonutStat
            pct={planned > 0 ? (evaluated / planned) * 100 : null}
            label="Cases evaluated"
            colorClass="text-neon-alt"
            sub={`${run.tc_counts.FAIL ?? 0} failed · ${run.tc_counts.NOT_RUN ?? 0} not run`}
          />
          <DonutStat
            pct={coverage.requirements_total > 0 ? coverage.coverage_pct : null}
            label="Req. coverage"
            colorClass="text-primary"
            sub={`${coverage.covered} of ${coverage.requirements_total} requirements`}
          />
        </div>

        {/* Cases: failures sorted first so the reader does not scroll past a passing run. */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">
              Test cases ({sortedRows.length})
            </h3>
            <VerdictCounts counts={run.tc_counts} />
          </div>

          {/* The run at a glance, before any measurements. Failures first here too,
              since it shares the same sorted rows. */}
          <RunCaseList rows={sortedRows} />

          {sortedRows.length === 0 ? (
            <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              This run has no planned test cases and produced no verdicts.
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  // ── Editorial layout ──────────────────────────────────────────────────────
  // All information present, segmented into three tabs so the engineer can
  // navigate directly to cases, metrics or run metadata without scrolling.
  if (variant === "editorial") {
    const editorialTabs = [
      { id: "cases", label: "Cases" },
      { id: "metrics", label: "Metrics" },
      { id: "details", label: "Details" },
    ] as const

    return (
      <div className="space-y-4 p-4 lg:p-6">
        {/* Header row: id, status, buttons — always visible above the tabs */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-lg font-semibold">{run.run_id}</h2>
            <RunStatusBadge status={run.status} />
            {(run.status === "planned" || run.status === "running") && (
              <Badge variant="outline">{run.origin}</Badge>
            )}
            {run.baseline_id && (
              <Badge variant="secondary">baseline {run.baseline_id}</Badge>
            )}
            <div className="ml-auto flex items-center gap-2">
              {run.origin === "planned" && (
                <RunTestRunButton
                  runId={run.run_id}
                  status={run.status}
                  plannedTcIds={run.planned_tc_ids}
                  onStatusChange={(updated) => {
                    onRunChanged(updated)
                    refetch()
                  }}
                />
              )}
              <Link
                href={`/test-results/${encodeURIComponent(run.run_id)}`}
                className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                Full report
              </Link>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{run.label || "(no label)"}</p>
        </div>

        {/* Tab strip */}
        <div className="flex border-b" role="tablist">
          {editorialTabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={editorialTab === id}
              onClick={() => setEditorialTab(id)}
              className={cn(
                "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                editorialTab === id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {editorialTab === "cases" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-sm font-semibold">
                Test cases ({rows.length})
              </h3>
              <VerdictCounts counts={run.tc_counts} />
            </div>
            {rows.length === 0 ? (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                This run has no planned test cases and produced no verdicts.
              </p>
            ) : (
              <RunCaseList rows={rows} />
            )}
          </div>
        )}

        {editorialTab === "metrics" && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label="Success rate"
              value={formatSuccessRate(run.success_rate)}
              hint={
                evaluated === 0
                  ? "no test case has been evaluated"
                  : `${run.tc_counts.PASS ?? 0} of ${evaluated} evaluated cases passed`
              }
            />
            <Stat
              label="Test cases"
              value={`${evaluated} / ${planned}`}
              hint={`${run.tc_counts.FAIL ?? 0} failed · ${
                run.tc_counts.NOT_RUN ?? 0
              } not run`}
            />
            <Stat
              label="Requirement coverage"
              value={`${coverage.covered} / ${coverage.requirements_total}`}
              hint={`${coverage.coverage_pct}% of the register · ${coverage.passed} passed · ${coverage.failed} failed`}
            />
          </div>
        )}

        {editorialTab === "details" && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Scenario" value={run.scenario ?? "not set"} />
            <Field label="Created" value={formatUtc(run.created_utc) ?? "not recorded"} />
            <Field label="Started" value={formatUtc(run.started_utc) ?? "not started"} />
            <Field
              label="Evaluated"
              value={formatUtc(run.evaluated_utc) ?? "not evaluated"}
            />
            <Field label="Planned cases" value={String(planned)} />
            <Field label="Traces" value={String(run.trace_keys.length)} />
          </dl>
        )}
      </div>
    )
  }

  // ── Common layout (engineer view — unchanged from original) ────────────────
  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-lg font-semibold">{run.run_id}</h2>
          <RunStatusBadge status={run.status} />
          {(run.status === "planned" || run.status === "running") && (
            <Badge variant="outline">{run.origin}</Badge>
          )}
          {run.baseline_id && (
            <Badge variant="secondary">baseline {run.baseline_id}</Badge>
          )}

          <div className="ml-auto flex items-center gap-2">
            {run.origin === "planned" && (
              <RunTestRunButton
                runId={run.run_id}
                status={run.status}
                plannedTcIds={run.planned_tc_ids}
                onStatusChange={(updated) => {
                  onRunChanged(updated)
                  refetch()
                }}
              />
            )}
            <Link
              href={`/test-results/${encodeURIComponent(run.run_id)}`}
              className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Full report
            </Link>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{run.label || "(no label)"}</p>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Scenario" value={run.scenario ?? "not set"} />
          <Field label="Created" value={formatUtc(run.created_utc) ?? "not recorded"} />
          <Field label="Started" value={formatUtc(run.started_utc) ?? "not started"} />
          <Field
            label="Evaluated"
            value={formatUtc(run.evaluated_utc) ?? "not evaluated"}
          />
          <Field label="Planned cases" value={String(planned)} />
          <Field label="Traces" value={String(run.trace_keys.length)} />
        </dl>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Success rate"
          value={formatSuccessRate(run.success_rate)}
          hint={
            evaluated === 0
              ? "no test case has been evaluated"
              : `${run.tc_counts.PASS ?? 0} of ${evaluated} evaluated cases passed`
          }
        />
        <Stat
          label="Test cases"
          value={`${evaluated} / ${planned}`}
          hint={`${run.tc_counts.FAIL ?? 0} failed · ${
            run.tc_counts.NOT_RUN ?? 0
          } not run`}
        />
        <Stat
          label="Requirement coverage"
          value={`${coverage.covered} / ${coverage.requirements_total}`}
          hint={`${coverage.coverage_pct}% of the register · ${coverage.passed} passed · ${coverage.failed} failed`}
        />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold">Test cases ({rows.length})</h3>
          <VerdictCounts counts={run.tc_counts} />
        </div>

        {/* One line per case, expandable to that case's result. The details used to
            sit in a second stack below this list, so every result was on screen
            whether or not anyone wanted it and each verdict was rendered twice. */}
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            This run has no planned test cases and produced no verdicts.
          </p>
        ) : (
          <RunCaseList rows={rows} />
        )}
      </div>
    </div>
  )
}

/**
 * Inline SVG donut ring for the showcase headline numbers.
 * Uses the same stroke-dasharray technique as coverage-donuts.tsx — no library,
 * just geometry. Colour is a Tailwind token class so both themes work.
 */
function DonutStat({
  pct,
  label,
  colorClass,
  sub,
}: {
  pct: number | null | undefined
  label: string
  colorClass: string
  sub?: string
}) {
  const R = 30
  const C = 2 * Math.PI * R
  const safePct = pct !== null && pct !== undefined ? Math.max(0, Math.min(100, pct)) : 0
  const filled = (safePct / 100) * C

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative h-20 w-20">
        <svg
          viewBox="0 0 72 72"
          className="h-full w-full -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="36"
            cy="36"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            className="text-border"
          />
          {pct !== null && pct !== undefined && (
            <circle
              cx="36"
              cy="36"
              r={R}
              fill="none"
              stroke="currentColor"
              strokeWidth="6"
              strokeDasharray={`${filled} ${C - filled}`}
              strokeLinecap="round"
              className={colorClass}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-semibold tabular-nums">
            {pct !== null && pct !== undefined ? `${Math.round(pct)}%` : "—"}
          </span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">{label}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  )
}

/** Nothing selected, or nothing to select - said in words, never a blank pane. */
export function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md space-y-2 text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}
