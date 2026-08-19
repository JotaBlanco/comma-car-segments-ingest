"use client"

import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  caseCounts,
  deriveSuccessRate,
  formatSuccessRate,
  formatUtc,
  isUnevaluated,
  RUN_STATUS_LABEL,
  RUN_STATUS_VARIANT,
  type RunSummaryPlus,
} from "./verdict"
import { VerdictCounts } from "./verdict-badge"

/**
 * The run register, newest first. One row per run, with the execution status,
 * the backend's success rate and the per-test-case verdict counts - the same
 * numbers the run report recomputes from the verdict documents themselves.
 *
 * Seeded runs carry no `created_utc` and planned runs carry no `evaluated_utc`,
 * so the timestamp column shows whichever exists and says which one it is rather
 * than silently substituting one for the other.
 */
export function RunListTable({ runs }: { runs: RunSummaryPlus[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[110px]">Run</TableHead>
          <TableHead>Label</TableHead>
          <TableHead className="w-[170px]">Scenario</TableHead>
          <TableHead className="w-[170px]">Timestamp</TableHead>
          <TableHead className="w-[110px]">Success</TableHead>
          <TableHead className="w-[230px]">Verdicts</TableHead>
          <TableHead className="w-[90px] text-right">Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <RunRow key={run.run_id} run={run} />
        ))}
      </TableBody>
    </Table>
  )
}

function RunRow({ run }: { run: RunSummaryPlus }) {
  const created = formatUtc(run.created_utc)
  const evaluated = formatUtc(run.evaluated_utc)
  const planned = run.planned_tc_ids?.length ?? 0
  const status = run.status ?? "planned"
  const unevaluated = isUnevaluated(run)
  const counts = caseCounts(run)
  const successRate = run.success_rate ?? deriveSuccessRate(counts)

  return (
    <TableRow>
      <TableCell className="font-mono text-xs font-medium">{run.run_id}</TableCell>

      <TableCell>
        <div className="flex flex-col gap-1">
          <span className="text-sm">{run.label || "(no label)"}</span>
          <span className="text-xs text-muted-foreground">
            {planned} test case{planned === 1 ? "" : "s"} planned
            {run.trace_keys?.length ? ` · ${run.trace_keys.length} trace(s)` : ""}
          </span>
        </div>
      </TableCell>

      <TableCell>
        <div className="flex flex-col gap-1">
          <span className="text-sm">{run.scenario || "not set"}</span>
          <div className="flex items-center gap-1">
            <Badge
              variant={RUN_STATUS_VARIANT[status] ?? "outline"}
              className="w-fit text-[10px]"
            >
              {RUN_STATUS_LABEL[status] ?? status}
            </Badge>
            {/* See run-report-view: `origin` is how the run was created, not where it
                got to, so it stops showing once the run reaches a terminal state. */}
            {status === "planned" || status === "running" ? (
              <Badge variant="outline" className="w-fit text-[10px]">
                {run.origin}
              </Badge>
            ) : null}
          </div>
        </div>
      </TableCell>

      <TableCell className="text-xs text-muted-foreground">
        {evaluated ? (
          <span>evaluated {evaluated}</span>
        ) : created ? (
          <span>created {created}</span>
        ) : (
          <span>no timestamp recorded</span>
        )}
      </TableCell>

      <TableCell className="tabular-nums">
        {/* `success_rate` is null - never 0 - until something is evaluated. */}
        <span className={unevaluated ? "text-xs text-muted-foreground" : "text-sm"}>
          {formatSuccessRate(successRate)}
        </span>
      </TableCell>

      <TableCell>
        {/* Case-level counts, NOT_RUN included: a partially evaluated run must
            show what is still missing rather than round it away. */}
        <VerdictCounts
          counts={counts}
          emptyLabel={unevaluated ? "not run yet" : "no verdicts"}
        />
      </TableCell>

      <TableCell className="text-right">
        <Button asChild variant="outline" size="sm">
          <Link href={`/test-results/${encodeURIComponent(run.run_id)}`}>Open</Link>
        </Button>
      </TableCell>
    </TableRow>
  )
}
