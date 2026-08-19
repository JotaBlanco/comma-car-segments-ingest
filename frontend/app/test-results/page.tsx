"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react"
import { MainLayout } from "@/components/layout/main-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CoverageDonuts } from "@/components/v-model/coverage-donuts"
import { RunListTable } from "@/components/v-model/results/run-list-table"
import { useRunList } from "@/components/v-model/results/use-run-list"
import { isUnevaluated } from "@/components/v-model/results/verdict"

/**
 * Test Results - the run register.
 *
 * The list is the entry point of the stage: every run the backend knows about,
 * newest first, with the verdict summary it reported. "Open" navigates to
 * `/test-results/{run_id}`, which is where the per-test-case verdicts live.
 *
 * A run with no verdicts is shown as "not run yet" rather than as a zero score -
 * that is the normal state of a run created in the Add Test Run dialog, whose
 * measurement files have not been evaluated.
 *
 * Above the list, `CoverageDonuts` summarises the whole register - requirement
 * coverage and verification, and how much of the test suite has run. It loads its
 * own data and degrades on its own; it can never blank this page.
 */
export default function TestResultsPage() {
  const { runs, loading, error, refetch } = useRunList()
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return runs
    return runs.filter((run) =>
      [run.run_id, run.label ?? "", run.scenario ?? "", run.origin]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    )
  }, [runs, query])

  const evaluatedCount = useMemo(
    () => runs.filter((run) => !isUnevaluated(run)).length,
    [runs]
  )

  return (
    <MainLayout>
      <div className="max-w-7xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Test Results</h1>
            <p className="text-sm text-muted-foreground">
              {loading
                ? "Loading test runs..."
                : `${runs.length} run${runs.length === 1 ? "" : "s"}, ${evaluatedCount} evaluated`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by run, label or scenario"
              className="w-72"
            />
            <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </div>

        <CoverageDonuts />

        {loading ? (
          <div className="flex items-center gap-2 rounded-md border p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading test runs...
          </div>
        ) : error ? (
          <div className="space-y-2 rounded-md border p-6 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              The test run register is unavailable
            </div>
            <p className="text-muted-foreground">{error.message}</p>
            <p className="text-xs text-muted-foreground">
              GET /api/v1/vmodel/runs did not return a result. Check the backend, then
              refresh.
            </p>
          </div>
        ) : runs.length === 0 ? (
          <div className="space-y-1 rounded-md border border-dashed p-8 text-center">
            <p className="text-sm font-medium">No test runs yet</p>
            <p className="text-sm text-muted-foreground">
              Create one from the Test Run page. It will appear here immediately, marked
              as not run until its measurements are evaluated.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            No run matches &quot;{query}&quot;.
          </div>
        ) : (
          <div className="rounded-md border">
            <RunListTable runs={filtered} />
          </div>
        )}
      </div>
    </MainLayout>
  )
}
