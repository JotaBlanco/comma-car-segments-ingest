"use client"

import { Badge } from "@/components/ui/badge"
import type { VerdictStatus, VModelRunStatus } from "@/types/vmodel"

const RUN_STATUS_LABEL: Record<VModelRunStatus, string> = {
  planned: "Planned",
  running: "Running",
  completed: "Completed",
  error: "Error",
}

const RUN_STATUS_VARIANT: Record<
  VModelRunStatus,
  "secondary" | "info" | "outline" | "destructive"
> = {
  planned: "secondary",
  running: "info",
  // Deliberately not green: `completed` means execution finished, not that it passed.
  // Green belongs to the verdicts, and to the success rate derived from them.
  completed: "outline",
  error: "destructive",
}

/** Execution state of a Test Run. */
export function RunStatusBadge({ status }: { status: VModelRunStatus }) {
  return (
    <Badge variant={RUN_STATUS_VARIANT[status] ?? "secondary"}>
      {RUN_STATUS_LABEL[status] ?? status}
    </Badge>
  )
}

const VERDICT_LABEL: Record<VerdictStatus, string> = {
  PASS: "PASS",
  FAIL: "FAIL",
  INCONCLUSIVE: "INCONCLUSIVE",
  NOT_RUN: "Not run",
}

const VERDICT_VARIANT: Record<
  VerdictStatus,
  "success" | "destructive" | "warning" | "outline"
> = {
  PASS: "success",
  FAIL: "destructive",
  // INCONCLUSIVE is not a soft pass: nothing was measured, so it is flagged, not greened.
  INCONCLUSIVE: "warning",
  NOT_RUN: "outline",
}

/** Verdict of one test case. */
export function VerdictBadge({ status }: { status: VerdictStatus }) {
  return (
    <Badge variant={VERDICT_VARIANT[status] ?? "outline"}>
      {VERDICT_LABEL[status] ?? status}
    </Badge>
  )
}
