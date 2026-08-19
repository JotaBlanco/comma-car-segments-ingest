"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useVmRunsApi } from "@/lib/hooks/use-api"
import type { RunDetailSummary } from "@/types/vmodel"
import { RunStatusBadge, VerdictBadge } from "./run-status-badge"

interface RunSummaryPanelProps {
  runId: string | null
  /** Bumped by the caller after a run changes state, to force a refetch. */
  refreshKey?: number
}

/** One headline number with its label. Deliberately plain - styling is a later pass. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * What a run produced, in the three terms the user asked for: per-test-case PASS / FAIL /
 * INCONCLUSIVE / not-run, the requirement coverage the run contributes, and the overall
 * success rate.
 *
 * All of it comes from one call - `GET /api/v1/vmodel/runs/{run_id}/summary` - rather than
 * from the client stitching `/results` to `/runs/{id}/traces` to `/coverage`. The rollup
 * rules (worst verdict wins per case; a case with no verdict is NOT_RUN; success rate is
 * null rather than 0 % when nothing was evaluated) then live in exactly one place, so this
 * pane and the run list cannot drift apart. See backend/api/vm_run_summary.py.
 *
 * Data fetching is the established plain-`fetch`-in-`useEffect` pattern from
 * `lib/hooks/use-vm-test-specs.ts`: local loading / error state, a cancel flag, no
 * React Query.
 */
export function RunSummaryPanel({ runId, refreshKey = 0 }: RunSummaryPanelProps) {
  const vmRunsApi = useVmRunsApi()
  const [detail, setDetail] = useState<RunDetailSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!runId) {
      setDetail(null)
      return
    }
    let cancelled = false

    async function fetchSummary(id: string) {
      try {
        setLoading(true)
        setError(null)
        const data = await vmRunsApi.summary(id)
        if (!cancelled) setDetail(data)
      } catch (err) {
        if (!cancelled) {
          setDetail(null)
          setError(err instanceof Error ? err : new Error("Failed to load the run summary"))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchSummary(runId)
    return () => {
      cancelled = true
    }
  }, [runId, refreshKey])

  if (!runId) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        Select a run above to see its test cases, coverage and success rate.
      </p>
    )
  }

  if (loading && !detail) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading the summary for {runId}&hellip;
      </p>
    )
  }

  if (error) {
    return (
      <p className="flex items-start gap-2 p-6 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {error.message}
      </p>
    )
  }

  if (!detail) return null

  const { run, coverage, test_cases: testCases } = detail
  const evaluated = testCases.filter((tc) => tc.status !== "NOT_RUN").length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">{run.run_id}</h2>
        <RunStatusBadge status={run.status} />
        <span className="text-sm text-muted-foreground">{run.label}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Success rate"
          // Null, not 0 %: a run nobody has evaluated has no rate, and showing 0 % would
          // read as "everything failed".
          value={run.success_rate === null ? "—" : `${run.success_rate}%`}
          hint={`${run.tc_counts.PASS ?? 0} passed of ${evaluated} evaluated`}
        />
        <Stat
          label="Test cases"
          value={`${evaluated} / ${testCases.length}`}
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

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Test case</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead>Requirements covered</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {testCases.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                  This run has no planned test cases.
                </TableCell>
              </TableRow>
            ) : (
              testCases.map((testCase) => (
                <TableRow key={testCase.tc_id}>
                  <TableCell className="align-top">
                    <div className="font-mono text-sm">{testCase.tc_id}</div>
                    <div className="text-xs text-muted-foreground">{testCase.title}</div>
                  </TableCell>
                  <TableCell className="align-top">
                    <VerdictBadge status={testCase.status} />
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    {testCase.req_ids.length === 0 ? (
                      <span className="text-muted-foreground">
                        None — this case verifies no requirement
                      </span>
                    ) : (
                      <span className="font-mono">{testCase.req_ids.join(", ")}</span>
                    )}
                  </TableCell>
                  {/* Rendered in full, never truncated to a glyph: the reason is the
                      evidence, and it is populated even on PASS. */}
                  <TableCell className="align-top text-xs text-muted-foreground">
                    {testCase.reason || (testCase.status === "NOT_RUN" ? "Not executed yet" : "—")}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
