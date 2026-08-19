"use client"

import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { CaseSeries } from "@/types/vm-execution"
import { VERDICT_ORDER, type Trace, type VerdictStatus } from "@/types/vmodel"
import { CaseResultCard } from "./case-result-card"
import { sourceLabel } from "./series"
import {
  formatSuccessRate,
  formatUtc,
  RUN_STATUS_LABEL,
  RUN_STATUS_VARIANT,
  VERDICT_LABEL,
  type CaseRow,
  type RunMetrics,
  type RunSummaryPlus,
} from "./verdict"
import { VerdictBadge } from "./verdict-badge"

interface RunReportViewProps {
  run: RunSummaryPlus
  traces: Trace[]
  rows: CaseRow[]
  metrics: RunMetrics
  /** Plot data per test case id; empty until the run has been executed. */
  series?: Map<string, CaseSeries>
}

/**
 * The result view for one run.
 *
 * Two states, and the difference between them is the point of this screen:
 *
 * - Evaluated - verdicts exist. The header shows the success rate over the cases
 *   that were evaluated (PASS / PASS + FAIL + INCONCLUSIVE, the backend's own
 *   definition), with not-run cases counted separately so a case nobody measured
 *   is never mistaken for a case that failed.
 * - Not run yet - a run created in the Add Test Run dialog. It has uploads but
 *   no traces and no verdicts. There is no success rate at all in that state:
 *   the header says so and every planned case is a NOT_RUN row.
 */
export function RunReportView({
  run,
  traces,
  rows,
  metrics,
  series,
}: RunReportViewProps) {
  const [filter, setFilter] = useState<VerdictStatus | null>(null)

  const visibleRows = useMemo(
    () => (filter === null ? rows : rows.filter((row) => row.status === filter)),
    [rows, filter]
  )

  const hasVerdicts = metrics.evaluated > 0
  // Every executed case records where its samples came from. They agree in practice, but
  // the header states it rather than assuming it - a report that does not say what it was
  // computed from is not evidence.
  const sources = Array.from(
    new Set(Array.from(series?.values() ?? [], (item) => item.source))
  )

  return (
    <div className="space-y-6">
      <RunHeader run={run} traces={traces} sources={sources} />

      {hasVerdicts ? (
        <MetricsPanel run={run} metrics={metrics} />
      ) : (
        <NotRunPanel run={run} plannedCount={rows.length} />
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-semibold">
            Test cases ({visibleRows.length}
            {filter !== null ? ` of ${rows.length}` : ""})
          </h2>
          <FilterChip
            label="All"
            active={filter === null}
            count={rows.length}
            onClick={() => setFilter(null)}
          />
          {VERDICT_ORDER.map((status) => (
            <FilterChip
              key={status}
              label={VERDICT_LABEL[status]}
              active={filter === status}
              count={metrics.counts[status]}
              onClick={() => setFilter(filter === status ? null : status)}
            />
          ))}
        </div>

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            This run has no planned test cases and produced no verdicts.
          </p>
        ) : visibleRows.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No test case has that verdict in this run.
          </p>
        ) : (
          <div className="space-y-4">
            {visibleRows.map((row) => (
              <CaseResultCard key={row.tcId} row={row} series={series?.get(row.tcId)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RunHeader({
  run,
  traces,
  sources,
}: {
  run: RunSummaryPlus
  traces: Trace[]
  sources: string[]
}) {
  const created = formatUtc(run.created_utc)
  const startedAt = formatUtc(run.started_utc)
  const evaluatedAt = formatUtc(run.evaluated_utc)
  const status = run.status ?? "planned"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="font-mono text-base">{run.run_id}</CardTitle>
          <Badge variant={RUN_STATUS_VARIANT[status] ?? "outline"}>
            {RUN_STATUS_LABEL[status] ?? status}
          </Badge>
          {/* `origin` says how the run was created, not where it got to. Next to a
              Completed badge a "planned" chip reads as a contradictory second status,
              so it only shows while the run has not finished. */}
          {status === "planned" || status === "running" ? (
            <Badge variant="outline">{run.origin}</Badge>
          ) : null}
          {run.baseline_id ? (
            <Badge variant="secondary">baseline {run.baseline_id}</Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{run.label || "(no label)"}</p>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <HeaderField label="Scenario" value={run.scenario ?? "not set"} />
          <HeaderField label="Created" value={created ?? "not recorded"} />
          <HeaderField label="Started" value={startedAt ?? "not started"} />
          <HeaderField label="Evaluated" value={evaluatedAt ?? "not evaluated"} />
          <HeaderField
            label="Planned test cases"
            value={String(run.planned_tc_ids?.length ?? 0)}
          />
          <HeaderField label="Traces" value={String(traces.length)} />
          <HeaderField label="Uploads" value={String(run.tc_uploads?.length ?? 0)} />
          <HeaderField
            label="Signals read from"
            value={sources.length > 0 ? sources.map(sourceLabel).join(", ") : "not evaluated"}
          />
        </dl>

        {traces.length > 0 ? (
          <div className="mt-3 space-y-1">
            {traces.map((trace) => (
              <p
                key={trace.trace_key}
                className="font-mono text-[11px] text-muted-foreground"
              >
                {trace.trace_key}
                {trace.ingest_status ? ` (${trace.ingest_status})` : ""}
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function MetricsPanel({ run, metrics }: { run: RunSummaryPlus; metrics: RunMetrics }) {
  // The backend computes the same ratio over the same denominator; prefer its
  // value so the run list and this panel can never print different percentages
  // for one run, and fall back to the locally derived one if it is absent.
  const successRate =
    run.success_rate ?? (metrics.passRate === null ? null : metrics.passRate * 100)

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-8 pt-6">
        <div>
          <p className="text-3xl font-semibold tabular-nums">
            {formatSuccessRate(successRate)}
          </p>
          <p className="text-xs text-muted-foreground">
            success rate,{" "}
            {metrics.evaluated === 0
              ? "no test case has been evaluated"
              : `${metrics.counts.PASS} of ${metrics.evaluated} evaluated cases passed`}
          </p>
        </div>

        <div>
          <p className="text-3xl font-semibold tabular-nums">
            {metrics.evaluated}/{metrics.planned}
          </p>
          <p className="text-xs text-muted-foreground">planned cases with a verdict</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {VERDICT_ORDER.filter((status) => metrics.counts[status] > 0).map((status) => (
            <div key={status} className="flex items-center gap-1.5">
              <VerdictBadge status={status} />
              <span className="text-sm tabular-nums">{metrics.counts[status]}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The honest empty state. No percentage is shown, because none exists yet: the
 * run has been planned and its MF4s attached, and nothing has evaluated them.
 */
function NotRunPanel({
  run,
  plannedCount,
}: {
  run: RunSummaryPlus
  plannedCount: number
}) {
  const uploads = run.tc_uploads ?? []

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <VerdictBadge status="NOT_RUN" />
          <p className="text-sm font-medium">This run has not been evaluated yet</p>
        </div>
        <p className="text-sm text-muted-foreground">
          {plannedCount} test case{plannedCount === 1 ? " is" : "s are"} planned and{" "}
          {uploads.length} measurement file{uploads.length === 1 ? " is" : "s are"}{" "}
          attached, but no verdicts have been produced. There is no success rate for this
          run, and the cases below are listed as not run.
        </p>

        {uploads.length > 0 ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {uploads.map((upload) => (
              <li key={`${upload.tc_id}-${upload.upload_id ?? "none"}`}>
                <span className="font-mono">{upload.tc_id}</span>
                {" - "}
                {upload.filename || upload.upload_id || "no file attached"}
                {upload.attached_utc ? ` (${formatUtc(upload.attached_utc)})` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  )
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      onClick={onClick}
      className="h-7 px-2.5 text-xs"
    >
      {label} <span className="ml-1 tabular-nums opacity-70">{count}</span>
    </Button>
  )
}

function HeaderField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  )
}
