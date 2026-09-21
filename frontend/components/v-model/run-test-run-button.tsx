"use client"

import { useState } from "react"
import { Play } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/lib/hooks/use-toast"
import { useVmRunsApi } from "@/lib/hooks/use-api"
import type { RunSummary, VModelRunStatus } from "@/types/vmodel"

interface RunTestRunButtonProps {
  runId: string
  /** Current execution state; a run already running cannot be started again. */
  status: VModelRunStatus
  /** Test case ids planned for this run; used only for the result message. */
  plannedTcIds?: string[]
  /** Called with the updated run so the caller can refresh its list or detail. */
  onStatusChange?: (run: RunSummary) => void
  size?: "sm" | "default"
}

/**
 * Runs a Test Run.
 *
 * One call: `POST /api/v1/vmodel/runs/{run_id}/execute`. The backend moves the run to
 * `running`, evaluates every planned test case that has an implementation in
 * `api/vm_eval/catalog.py` against the decoded signals, writes the verdicts into
 * `vm_results` (plus the measurement into `vm_traces` and the plots into
 * `vm_result_series`), and moves the run to `completed`. There is no polling because there
 * is no job queue: the evaluation is a partition-pruned scan plus a few hundred thousand
 * float operations, and it returns inside the request.
 *
 * The button reports what actually happened rather than claiming success: how many cases
 * passed and failed, and how many were skipped because no implementation covers them. A
 * skipped case stays NOT_RUN in the report - it is never counted as a pass.
 */
export function RunTestRunButton({
  runId,
  status,
  plannedTcIds = [],
  onStatusChange,
  size = "sm",
}: RunTestRunButtonProps) {
  const { toast } = useToast()
  const vmRunsApi = useVmRunsApi()
  const [running, setRunning] = useState(false)

  const handleRun = async (event: React.MouseEvent) => {
    // The table row navigates/selects on click; without this the button would do that
    // instead of running.
    event.stopPropagation()
    event.preventDefault()

    setRunning(true)
    try {
      const { report, summary } = await vmRunsApi.execute(runId)
      onStatusChange?.(summary.run)

      const passed = report.executed.filter((item) => item.status === "PASS").length
      const failed = report.executed.filter((item) => item.status === "FAIL").length
      const skipped = report.skipped.length
      const parts = [`${passed} passed`, `${failed} failed`]
      if (skipped > 0) parts.push(`${skipped} not implemented`)

      toast({
        title: `${runId} completed`,
        description:
          report.executed.length > 0
            ? `${parts.join(", ")}. Open the run to see the criteria and the signal plots.`
            : `Nothing was evaluated: none of the ${plannedTcIds.length} planned test cases has an implementation.`,
        variant: failed > 0 ? "destructive" : undefined,
      })
    } catch (error) {
      toast({
        title: `Could not run ${runId}`,
        description:
          error instanceof Error ? error.message : "POST /vmodel/runs/{id}/execute failed",
        variant: "destructive",
      })
    } finally {
      setRunning(false)
    }
  }

  const busy = running || status === "running"

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={busy}
      loading={running}
      onClick={handleRun}
      title={status === "running" ? "This run is already running" : undefined}
    >
      {!running && <Play className="mr-2 h-3.5 w-3.5" />}
      {busy ? "Running" : status === "planned" ? "Run" : "Run again"}
    </Button>
  )
}
