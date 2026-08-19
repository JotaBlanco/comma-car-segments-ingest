"use client"

import { Play } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/lib/hooks/use-toast"

interface RunTestRunButtonProps {
  runId: string
  /** Test case ids planned for this run; shown in the not-yet-wired message. */
  plannedTcIds?: string[]
  size?: "sm" | "default"
}

/**
 * Triggers execution of a Test Run.
 *
 * ============================================================================
 * TODO(tomas): wire this to QuixLab script execution.
 *
 * This is the ONLY seam. Everything else for a Test Run already works: the run
 * exists in Mongo as a `tests` document with a `vmodel` sub-document, carries
 * its planned test case ids, and carries the `upload_id` of the MF4 attached to
 * each one — which is the lakehouse record id, so a script can query
 * `mf4_signals_v4` with `WHERE upload_id = …` and evaluate that test case.
 *
 * To implement, replace the body of `handleRun` below with a call that runs the
 * per-test-case implementation notebooks in QuixLab. The implementation ids are
 * derived from the test case ids: ACC-SYS-TC-011 -> ACC-SYS-TI-011, with cells
 * named `acc_sys_ti_011` (see quixlab/notebooks/acc_performance_tests.py).
 *
 * Deliberately not implemented here: no QuixLab client, no job submission, no
 * polling. Guessing that API would have to be unpicked later.
 * ============================================================================
 */
export function RunTestRunButton({
  runId,
  plannedTcIds = [],
  size = "sm",
}: RunTestRunButtonProps) {
  const { toast } = useToast()

  const handleRun = (e: React.MouseEvent) => {
    // The table row navigates on click; without this the button opens the run
    // detail page instead of running.
    e.stopPropagation()
    e.preventDefault()
    // TODO(tomas): replace with QuixLab execution for `runId` / `plannedTcIds`.
    toast({
      title: "Execution not wired yet",
      description:
        plannedTcIds.length > 0
          ? `${runId} would run ${plannedTcIds.length} test case${
              plannedTcIds.length === 1 ? "" : "s"
            } in QuixLab.`
          : `${runId} has no planned test cases yet.`,
    })
  }

  return (
    <Button type="button" variant="outline" size={size} onClick={handleRun}>
      <Play className="mr-2 h-3.5 w-3.5" />
      Run Test Run
    </Button>
  )
}
