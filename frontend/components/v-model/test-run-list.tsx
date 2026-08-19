"use client"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useDateFormatter } from "@/lib/hooks/use-date-formatter"
import type { RunSummary } from "@/types/vmodel"
import { RunStatusBadge } from "./run-status-badge"
import { RunTestRunButton } from "./run-test-run-button"

interface TestRunListProps {
  runs: RunSummary[]
  selectedRunId: string | null
  onSelect: (runId: string) => void
  /** Called after a run changes state, so the caller can refetch the list. */
  onRunChanged: (run: RunSummary) => void
}

/** `4 / 9` with the pass count first: the two numbers that decide whether to look further. */
function PassFail({ run }: { run: RunSummary }) {
  const pass = run.tc_counts.PASS ?? 0
  const fail = run.tc_counts.FAIL ?? 0
  const inconclusive = run.tc_counts.INCONCLUSIVE ?? 0

  if (pass + fail + inconclusive === 0) {
    return <span className="text-muted-foreground">&mdash;</span>
  }
  return (
    <span className="tabular-nums">
      <span className="text-success">{pass} pass</span>
      {fail > 0 && <span className="text-destructive"> · {fail} fail</span>}
      {inconclusive > 0 && (
        <span className="text-muted-foreground"> · {inconclusive} inconc.</span>
      )}
    </span>
  )
}

/**
 * The Test Run stage list: one row per run, newest first.
 *
 * Every column answers a question the user asked of a run - what state is it in, how many
 * test cases does it carry, how many passed, what is the success rate. Nothing else is
 * shown: campaign, environment and operator are empty on a V-model run by design (see
 * `create_run` in backend/api/routes/vm_runs.py) and columns of blanks were most of what
 * made the old surface unreadable.
 *
 * A row selects rather than navigates - the summary renders beside it - so the Run button
 * stays usable in place. It still calls `stopPropagation` for exactly that reason.
 */
export function TestRunList({
  runs,
  selectedRunId,
  onSelect,
  onRunChanged,
}: TestRunListProps) {
  const { formatDate } = useDateFormatter()

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Test cases</TableHead>
            <TableHead>Verdicts</TableHead>
            <TableHead className="text-right">Success rate</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                No test runs yet. Add one to get started.
              </TableCell>
            </TableRow>
          ) : (
            runs.map((run) => (
              <TableRow
                key={run.run_id}
                onClick={() => onSelect(run.run_id)}
                className={`cursor-pointer hover:bg-muted/50 ${
                  run.run_id === selectedRunId ? "bg-muted" : ""
                }`}
              >
                <TableCell>
                  <div className="font-medium">{run.run_id}</div>
                  <div className="text-xs text-muted-foreground">{run.label}</div>
                </TableCell>
                <TableCell>
                  <RunStatusBadge status={run.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {run.planned_tc_ids.length}
                </TableCell>
                <TableCell className="text-sm">
                  <PassFail run={run} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {run.success_rate === null ? (
                    <span className="text-muted-foreground">&mdash;</span>
                  ) : (
                    `${run.success_rate}%`
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {run.created_utc ? formatDate(run.created_utc) : "seeded"}
                </TableCell>
                <TableCell className="py-2">
                  {/* Only a stored run can change state; a seeded run has no document. */}
                  {run.origin === "planned" && (
                    <RunTestRunButton
                      runId={run.run_id}
                      status={run.status}
                      plannedTcIds={run.planned_tc_ids}
                      onStatusChange={onRunChanged}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
