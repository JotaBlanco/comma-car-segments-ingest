"use client"

import { useState } from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import type { CaseSeries, CriterionChart } from "@/types/vm-execution"
import type { TestResult } from "@/types/vmodel"
import {
  breachSeconds,
  chartHeadline,
  formatMargin,
  overshoot,
  sourceLabel,
} from "./series"
import { SignalChart } from "./signal-chart"
import { formatMeasuredVsBound, formatNumber, type CaseRow } from "./verdict"
import { VerdictBadge } from "./verdict-badge"

/**
 * One test case of the report: the verdict, the criteria in words and numbers, and the
 * plots that show how each one was reached.
 *
 * The charts are *not* behind the expander. They are the evidence, and a report where the
 * evidence needs a click is a report nobody looks at. What stays collapsed is the
 * machine-readable detail - trace keys, tolerances, implementation ids, the per-criterion
 * table - which a reviewer wants and a customer does not.
 *
 * A failing case is loud on purpose: destructive frame, tinted header, and a line saying
 * by how much and for how long the limit was exceeded. A case with no verdict is neither
 * loud nor a failure - it renders NOT_RUN and says so in words.
 */
export function CaseResultCard({ row, series }: { row: CaseRow; series?: CaseSeries }) {
  const [open, setOpen] = useState(false)
  const hasDetail = row.results.length > 0
  const failed = row.status === "FAIL"
  const charts = series?.charts ?? []

  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border",
        failed && "border-destructive/60"
      )}
      aria-labelledby={`case-${row.tcId}`}
    >
      <header
        className={cn(
          "flex flex-wrap items-start gap-3 border-b px-4 py-3",
          failed ? "bg-destructive/10" : "bg-muted/30"
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span id={`case-${row.tcId}`} className="font-mono text-xs font-semibold">
              {row.tcId}
            </span>
            {row.mnemonic ? (
              <span className="text-xs text-muted-foreground">{row.mnemonic}</span>
            ) : null}
          </div>
          <h3 className="mt-0.5 text-sm font-medium">{row.title}</h3>
        </div>
        <VerdictBadge status={row.status} className="mt-0.5 shrink-0 px-3 py-1 text-sm" />
      </header>

      <div className="space-y-5 px-4 py-4">
        {hasDetail ? (
          row.results.map((result) => (
            <p key={`reason-${result.result_id}`} className="text-sm">
              {result.reason || formatMeasuredVsBound(result) || "no measurand"}
            </p>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No verdict yet — this test case has not been evaluated. Press Run on the test run
            to evaluate it.
          </p>
        )}

        {charts.map((chart) => (
          <CriterionBlock key={chart.chart_id} chart={chart} />
        ))}

        {series ? (
          <p className="text-xs text-muted-foreground">
            {series.sample_count.toLocaleString()} samples over {series.duration_s.toFixed(1)} s,
            read from the {sourceLabel(series.source)}
            {series.scenario ? ` · scenario ${series.scenario}` : ""}
          </p>
        ) : null}

        {hasDetail ? (
          <div className="border-t pt-3">
            <button
              type="button"
              onClick={() => setOpen((previous) => !previous)}
              aria-expanded={open}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn("h-3.5 w-3.5 transition-transform duration-100", open && "rotate-90")}
                aria-hidden="true"
              />
              {open ? "Hide verdict detail" : "Verdict detail"}
            </button>

            {open ? (
              <div className="mt-3 space-y-4">
                {row.results.map((result) => (
                  <ResultDetail key={result.result_id} result={result} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** One criterion: what it asserts, what was measured, and the plot of it. */
function CriterionBlock({ chart }: { chart: CriterionChart }) {
  const failed = chart.verdict !== "PASS"
  const missed = overshoot(chart)
  const seconds = breachSeconds(chart)
  const margin = formatMargin(chart.margin)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          {chart.criterion_id}
        </span>
        <h4 className="text-sm font-medium">{chart.title}</h4>
        <VerdictBadge status={chart.verdict as CaseRow["status"]} />
      </div>

      <p className="text-xs text-muted-foreground">{chart.caption}</p>

      <p
        className={cn(
          "text-sm tabular-nums",
          failed ? "font-semibold text-destructive" : "font-medium"
        )}
      >
        {chartHeadline(chart)}
        {margin !== null ? (
          <span className="ml-2 font-normal text-muted-foreground">margin {margin}</span>
        ) : null}
        <span className="ml-2 font-normal text-muted-foreground">
            · {chart.n_samples.toLocaleString()} samples
        </span>
      </p>

      {failed && missed ? (
        <p className="text-sm font-medium text-destructive">
          Exceeded the limit by {missed}
          {seconds > 0 ? ` and stayed outside it for ${seconds.toFixed(2)} s` : ""}.
        </p>
      ) : null}

      <SignalChart chart={chart} />
    </div>
  )
}

function ResultDetail({ result }: { result: TestResult }) {
  const margin = formatNumber(result.margin)

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge status={result.status} />
        <span className="text-xs text-muted-foreground">
          {formatMeasuredVsBound(result) ?? "no measurand"}
          {margin !== null ? ` · margin ${margin} ${result.unit}` : ""}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <Field label="Window" value={result.window} />
        <Field label="Scope" value={result.scope} />
        <Field label="Samples in scope" value={String(result.samples_in_scope)} />
        <Field label="Tolerance" value={formatNumber(result.tolerance) ?? "0"} />
        <Field label="Requirements" value={result.req_ids.join(", ")} />
        <Field label="Implementation" value={result.impl_id ?? "—"} />
        <Field label="Trace" value={result.trace_key ?? "—"} mono />
        <Field label="Signals" value={result.signals.join(", ")} />
      </dl>

      {result.notes.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {result.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}

      {result.criteria.length > 0 ? <CriteriaTable result={result} /> : null}
    </div>
  )
}

function CriteriaTable({ result }: { result: TestResult }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-1 pr-3 font-medium">Criterion</th>
            <th className="py-1 pr-3 font-medium">Actual</th>
            <th className="py-1 pr-3 font-medium">Bound</th>
            <th className="py-1 pr-3 font-medium">Unit</th>
            <th className="py-1 font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {result.criteria.map((criterion) => (
            <tr key={criterion.criterion_id} className="border-b last:border-0">
              <td className="py-1 pr-3 font-mono">{criterion.criterion_id}</td>
              <td className="py-1 pr-3 tabular-nums">
                {formatNumber(criterion.actual) ?? "—"}
              </td>
              <td className="py-1 pr-3 tabular-nums">
                {formatNumber(criterion.bound) ?? "—"}
              </td>
              <td className="py-1 pr-3">{criterion.unit ?? result.unit ?? "—"}</td>
              <td className="py-1">{criterion.verdict ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono")}>{value}</dd>
    </div>
  )
}
