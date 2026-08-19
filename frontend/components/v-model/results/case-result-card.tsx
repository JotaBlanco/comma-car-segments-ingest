"use client"

import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TestResult } from "@/types/vmodel"
import { formatMeasuredVsBound, formatNumber, type CaseRow } from "./verdict"
import { VerdictBadge } from "./verdict-badge"

/**
 * One planned test case and the verdicts it produced.
 *
 * A case with no verdict is not an error and not a failure: it is a case whose
 * measurement has not been evaluated yet, so it renders a NOT_RUN badge and says
 * so in words. Collapsed, the row is the verdict plus measured-against-bound;
 * expanded, it shows the full `reason` string (required even on PASS), the
 * window and scope the verdict was judged in, and the per-criterion table when
 * the check reported one.
 */
export function CaseResultCard({ row }: { row: CaseRow }) {
  const [open, setOpen] = useState(false)
  const hasDetail = row.results.length > 0

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={!hasDetail}
        aria-expanded={open}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-2.5 text-left",
          hasDetail ? "hover:bg-muted/40" : "cursor-default"
        )}
      >
        <ChevronRight
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 transition-transform duration-100",
            open && "rotate-90",
            !hasDetail && "invisible"
          )}
          aria-hidden="true"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-medium">{row.tcId}</span>
            {row.mnemonic ? (
              <span className="text-xs text-muted-foreground">{row.mnemonic}</span>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm">{row.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hasDetail
              ? row.results.map((r) => formatMeasuredVsBound(r) ?? "no measurand").join(" · ")
              : "no verdict yet — this test case has not been evaluated"}
          </p>
        </div>

        <VerdictBadge status={row.status} className="mt-0.5 shrink-0" />
      </button>

      {open && hasDetail ? (
        <div className="space-y-4 border-t px-3 py-3">
          {row.results.map((result) => (
            <ResultDetail key={result.result_id} result={result} />
          ))}
        </div>
      ) : null}
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

      {/* `reason` is rendered in full, on PASS as well - it is the evidence. */}
      {result.reason ? <p className="text-sm">{result.reason}</p> : null}

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
