"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Loader2, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useVmRunsApi } from "@/lib/hooks/use-api"
import type { RunSummary } from "@/types/vmodel"
import { AddTestRunDialog } from "./add-test-run-dialog"
import { RunSummaryPanel } from "./run-summary-panel"
import { TestRunList } from "./test-run-list"

/** The register is ~40 runs; one page holds it, and the list is never paginated blind. */
const RUN_PAGE_SIZE = 200

interface TestRunStageProps {
  /** Run to select on first render, e.g. from `/tests?run=TR-0001`. */
  initialRunId?: string | null
}

/**
 * The Test Run stage: the list of runs on top, the summary of the selected run below.
 *
 * Selection rather than navigation. A run has no page of its own - `/test-results` is
 * owned by the results explorer and `/tests/[id]` is the Phase 2 bench-test detail, which
 * would show a V-model run as a wall of empty campaign / environment / operator fields.
 * Selecting keeps the list, the Run button and the verdicts on one screen, which is what
 * "did that run pass" actually needs.
 *
 * Runs are fetched here rather than in either child so both read the same array: starting
 * a run updates the row and the summary from one refetch.
 */
export function TestRunStage({ initialRunId = null }: TestRunStageProps) {
  const vmRunsApi = useVmRunsApi()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId)
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function fetchRuns() {
      try {
        setLoading(true)
        setError(null)
        const data = await vmRunsApi.list({ page: 1, page_size: RUN_PAGE_SIZE })
        if (!cancelled) setRuns(data.items ?? [])
      } catch (err) {
        if (!cancelled) {
          setRuns([])
          setError(err instanceof Error ? err : new Error("Failed to fetch test runs"))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchRuns()
    return () => {
      cancelled = true
    }
  }, [refetchTrigger])

  const refetch = useCallback(() => setRefetchTrigger((prev) => prev + 1), [])

  // A run that just changed state is selected as well as refetched: after pressing Run,
  // the thing you want to look at is that run.
  const handleRunChanged = useCallback(
    (run: RunSummary) => {
      setSelectedRunId(run.run_id)
      refetch()
    },
    [refetch]
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Test Run</h1>
          <p className="text-muted-foreground">
            {loading
              ? "Loading runs…"
              : `${runs.length} run${runs.length === 1 ? "" : "s"} · select one for its verdicts`}
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Test Run
        </Button>
      </div>

      <AddTestRunDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={handleRunChanged}
      />

      {loading && runs.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading test runs&hellip;
        </p>
      ) : error ? (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error.message}
        </p>
      ) : (
        <TestRunList
          runs={runs}
          selectedRunId={selectedRunId}
          onSelect={setSelectedRunId}
          onRunChanged={handleRunChanged}
        />
      )}

      <RunSummaryPanel runId={selectedRunId} refreshKey={refetchTrigger} />
    </div>
  )
}
