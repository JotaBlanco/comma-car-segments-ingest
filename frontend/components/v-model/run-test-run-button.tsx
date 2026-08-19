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
  /** Test case ids planned for this run; shown in the not-yet-wired message. */
  plannedTcIds?: string[]
  /** Called with the updated run so the caller can refresh its list or detail. */
  onStatusChange?: (run: RunSummary) => void
  size?: "sm" | "default"
}

/**
 * Starts a Test Run.
 *
 * What this button *does* do, today: move the run to `running` via
 * `POST /api/v1/vmodel/runs/{run_id}/status`. That is a real, persisted state change -
 * the run list, the summary pane and the underlying `tests` document all reflect it
 * immediately, and the run stays `running` until something reports back.
 *
 * ============================================================================
 * TODO(tomas): wire this to QuixLab script execution.
 *
 * This is the ONLY seam left. Everything around it works: the run exists in Mongo as a
 * `tests` document with a `vmodel` sub-document, carries its planned test case ids, and
 * now carries an execution status with a validated transition map.
 *
 * To implement, add the QuixLab job submission after the status call below. The
 * implementation ids are derived from the test case ids: ACC-SYS-TC-011 ->
 * ACC-SYS-TI-011, with cells named `acc_sys_ti_011` (see
 * quixlab/notebooks/acc_performance_tests.py).
 *
 * When the job finishes, post the terminal state back to the same endpoint:
 * `vmRunsApi.setStatus(runId, "completed")` or `"error"`. The backend refuses any
 * transition that would skip `running`, so a run can never claim an execution that did
 * not happen.
 *
 * Deliberately not implemented here: no QuixLab client, no job submission, no polling.
 * Guessing that API would have to be unpicked later.
 * ============================================================================
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
  const [starting, setStarting] = useState(false)

  const handleRun = async (e: React.MouseEvent) => {
    // The table row navigates/selects on click; without this the button would do that
    // instead of running.
    e.stopPropagation()
    e.preventDefault()

    setStarting(true)
    try {
      const run = await vmRunsApi.setStatus(runId, "running")
      onStatusChange?.(run)
      // TODO(tomas): submit the QuixLab job for `plannedTcIds` here, and post
      // "completed" / "error" back when it finishes.
      toast({
        title: `${runId} is running`,
        description:
          plannedTcIds.length > 0
            ? `${plannedTcIds.length} test case${
                plannedTcIds.length === 1 ? "" : "s"
              } queued. QuixLab execution is not wired yet, so no verdicts will arrive.`
            : `${runId} has no planned test cases, so there is nothing to execute.`,
      })
    } catch (error) {
      toast({
        title: `Could not start ${runId}`,
        description:
          error instanceof Error ? error.message : "POST /vmodel/runs/{id}/status failed",
        variant: "destructive",
      })
    } finally {
      setStarting(false)
    }
  }

  const running = status === "running"

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={running || starting}
      loading={starting}
      onClick={handleRun}
      title={running ? "This run is already running" : undefined}
    >
      {!starting && <Play className="mr-2 h-3.5 w-3.5" />}
      {running ? "Running" : status === "planned" ? "Run" : "Run again"}
    </Button>
  )
}
