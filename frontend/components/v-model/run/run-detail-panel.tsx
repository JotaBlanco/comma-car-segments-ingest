"use client"

import Link from "next/link"
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { CaseResultCard } from "@/components/v-model/results/case-result-card"
import { VerdictCounts } from "@/components/v-model/results/verdict-badge"
import { RunCaseList } from "./run-case-list"
import {
  formatSuccessRate,
  formatUtc,
} from "@/components/v-model/results/verdict"
import { RunStatusBadge } from "@/components/v-model/run-status-badge"
import { RunTestRunButton } from "@/components/v-model/run-test-run-button"
import type { RunSummary } from "@/types/vmodel"
import { useRunDetail } from "./use-run-detail"

interface RunDetailPanelProps {
  /** The `?select=` target. Null renders the "pick a run" placeholder. */
  runId: string | null
  /** Called after the run changes state, so the page can refetch its list. */
  onRunChanged: (run: RunSummary) => void
}

/**
 * Region C of the Test Run explorer: what the selected run contains and whether
 * it passed.
 *
 * The order of the pane is the order of the question. Which run is this and what
 * state is it in; then the three numbers that answer "did it pass"; then the list
 * of its test cases, each with its verdict and - where the run was evaluated - the
 * measured value against the bound it was judged by.
 *
 * The per-case rows are `CaseResultCard` from the Test Results stage, not a second
 * implementation of the same row. Collapsed it is verdict plus measured-vs-bound;
 * expanded it is the full `reason` string, the window, the scope and the
 * per-criterion table. Reusing it means the two surfaces cannot drift into
 * describing one verdict two different ways.
 *
 * A run with no verdicts is not a failed run: `success_rate` is null there and the
 * pane says "not run yet" in words rather than rendering 0%.
 */
export function RunDetailPanel({ runId, onRunChanged }: RunDetailPanelProps) {
  const { summary, rows, loading, error, refetch } = useRunDetail(runId)

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

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-lg font-semibold">{run.run_id}</h2>
          <RunStatusBadge status={run.status} />
          {/* Third place this chip lived. `origin` is how the run was created, not
              where it got to, so beside a Completed badge it reads as a second,
              contradictory status. Shown only while the run has not finished - same
              rule as the run list and the report header. It still gates the Run
              button below, which is about the run being stored, not about display. */}
          {(run.status === "planned" || run.status === "running") && (
            <Badge variant="outline">{run.origin}</Badge>
          )}
          {run.baseline_id && (
            <Badge variant="secondary">baseline {run.baseline_id}</Badge>
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* Only a stored run can change state; a seeded run has no document. */}
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
          // Null, never 0%: a run nobody evaluated has no rate, and 0% would read
          // as "everything failed".
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

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            This run has no planned test cases and produced no verdicts.
          </p>
        ) : (
          <div className="space-y-4">
            {/* What is in the run and whether it passed, before any measurements.
                Each line opens the test case on the Test Specification page. */}
            <RunCaseList rows={rows} />
            <div className="space-y-2">
              {rows.map((row) => (
                <CaseResultCard key={row.tcId} row={row} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** One headline number with its label. Plain by design - styling is a later pass. */
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
