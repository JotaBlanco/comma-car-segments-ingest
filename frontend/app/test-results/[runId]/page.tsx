"use client"

import { useParams } from "next/navigation"
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react"
import { MainLayout } from "@/components/layout/main-layout"
import { Button } from "@/components/ui/button"
import { RunReportView } from "@/components/v-model/results/run-report-view"
import { useRunReport } from "@/components/v-model/results/use-run-report"
import { RunTestRunButton } from "@/components/v-model/run-test-run-button"
import type { VModelRunStatus } from "@/types/vmodel"

/**
 * Test Results detail - one run, its per-test-case verdicts and its success rate.
 *
 * The route is `/test-results/[runId]`, so a result view is linkable and the
 * browser back button works; the run list keeps its own state rather than being
 * pushed aside by a modal.
 *
 * An unknown run id is the only error state here. A known run with no traces and
 * no verdicts is NOT an error - `RunReportView` renders it as "not run yet".
 */
export default function TestRunResultPage() {
  const params = useParams()
  // App Router hands params over already decoded, so decoding again here would
  // corrupt any id containing a literal '%'.
  const rawRunId = params.runId
  const runId = Array.isArray(rawRunId) ? rawRunId[0] : rawRunId || ""

  const { run, traces, rows, metrics, series, loading, error, refetch } =
    useRunReport(runId)

  return (
    <MainLayout backLink={{ href: "/test-results", label: "Back to Test Results" }}>
      <div className="max-w-7xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">
              Test Results{" "}
              <span className="font-mono text-lg text-muted-foreground">{runId}</span>
            </h1>
            <p className="text-sm text-muted-foreground">
              Verdict, criteria and signal plots for every test case in this run.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Run and read the result on the same screen: executing from here refetches
                the report, so the verdicts and the plots appear in place. */}
            {run ? (
              <RunTestRunButton
                runId={runId}
                status={(run.status as VModelRunStatus) ?? "planned"}
                plannedTcIds={run.planned_tc_ids ?? []}
                onStatusChange={refetch}
              />
            ) : null}
            <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 rounded-md border p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading run {runId}...
          </div>
        ) : error || !run ? (
          <div className="space-y-2 rounded-md border p-6 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Run {runId} could not be loaded
            </div>
            <p className="text-muted-foreground">
              {error ? error.message : "The backend returned no run for this id."}
            </p>
            <p className="text-xs text-muted-foreground">
              GET /api/v1/vmodel/runs/{runId} did not return a run. Check the id, then
              refresh.
            </p>
          </div>
        ) : (
          <RunReportView
            run={run}
            traces={traces}
            rows={rows}
            metrics={metrics}
            series={series}
          />
        )}
      </div>
    </MainLayout>
  )
}
