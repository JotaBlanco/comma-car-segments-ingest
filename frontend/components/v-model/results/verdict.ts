/**
 * Pure helpers for the Test Results stage.
 *
 * Everything here is deliberately side-effect free so the views stay thin: the
 * run list, the run report header and the per-case rows all read their numbers
 * from these functions rather than recomputing them inline.
 *
 * The one rule that governs the whole file: a run that has not been evaluated
 * has NO success rate. `passRate` returns null in that case and every caller
 * renders an explicit "not run yet", never a fabricated 0%.
 */

import type { RunSummary, TestResult, VerdictStatus } from "@/types/vmodel"
import { VERDICT_ORDER } from "@/types/vmodel"

/**
 * Fields the runs endpoint returns that `types/vmodel.ts` does not declare yet
 * (`status`, `started_utc`, `tc_counts`, `success_rate`, added with
 * `backend/api/vm_run_summary.py`). They are declared here, optional, so this
 * stage can consume them without editing the shared type another feature owns -
 * and so nothing breaks if the shared type gains them later.
 */
export type RunExecutionStatus = "planned" | "running" | "completed" | "error"

export interface RunSummaryExtras {
  status?: RunExecutionStatus | string
  started_utc?: string | null
  /** Verdict counts per PLANNED TEST CASE, worst verdict wins across traces. */
  tc_counts?: Partial<Record<VerdictStatus, number>>
  /** PASS / (PASS + FAIL + INCONCLUSIVE) over planned cases, 0-100. */
  success_rate?: number | null
}

export type RunSummaryPlus = RunSummary & RunSummaryExtras

export const RUN_STATUS_LABEL: Record<string, string> = {
  planned: "Planned",
  running: "Running",
  completed: "Completed",
  error: "Error",
}

/**
 * Execution status, given the same neon treatment as a verdict so the run row does
 * not sit under the neon summary band looking like a different product. Applied on
 * top of the `outline` variant; the app-wide filled variants are untouched.
 */
export const RUN_STATUS_NEON: Record<string, string> = {
  planned: "border-border bg-muted/40 text-muted-foreground",
  running:
    "border-neon-alt/40 bg-neon-alt/10 text-neon-alt shadow-[0_0_6px_-2px_hsl(var(--neon-alt))]",
  completed:
    "border-neon-pass/40 bg-neon-pass/10 text-neon-pass shadow-[0_0_6px_-2px_hsl(var(--neon-pass))]",
  error:
    "border-neon-fail/40 bg-neon-fail/10 text-neon-fail shadow-[0_0_6px_-2px_hsl(var(--neon-fail))]",
}

/**
 * Case-level counts when the backend supplies them, verdict-level counts
 * otherwise. `tc_counts` is what the result view aggregates, so preferring it
 * keeps the list and the detail view telling the same story.
 */
export function caseCounts(
  run: RunSummaryPlus
): Partial<Record<VerdictStatus, number>> {
  const counts = run.tc_counts
  if (counts && Object.keys(counts).length > 0) return counts
  return run.counts
}

/** Badge variant per verdict. `NOT_RUN` is neutral - it is not a failure. */
/**
 * Per-verdict neon treatment: the verdict's own colour on a faint tint, a hairline
 * ring and a small outward glow. Applied on top of the `outline` badge variant, so
 * the app-wide success / destructive variants every other page uses are untouched.
 *
 * The filled variants read as flat blocks of muted teal and maroon next to the neon
 * summary rings directly above them, which is what "too boring" meant.
 */
export const VERDICT_NEON: Record<VerdictStatus, string> = {
  PASS: "border-neon-pass/40 bg-neon-pass/10 text-neon-pass shadow-[0_0_6px_-2px_hsl(var(--neon-pass))]",
  FAIL: "border-neon-fail/40 bg-neon-fail/10 text-neon-fail shadow-[0_0_6px_-2px_hsl(var(--neon-fail))]",
  INCONCLUSIVE:
    "border-neon-warn/40 bg-neon-warn/10 text-neon-warn shadow-[0_0_6px_-2px_hsl(var(--neon-warn))]",
  NOT_RUN: "border-border bg-muted/40 text-muted-foreground",
}

export const VERDICT_LABEL: Record<VerdictStatus, string> = {
  PASS: "Pass",
  FAIL: "Fail",
  INCONCLUSIVE: "Inconclusive",
  NOT_RUN: "Not run",
}

/**
 * Worst-of aggregation, used when one test case produced several verdicts
 * (one per trace). A single FAIL makes the case fail; an INCONCLUSIVE outranks
 * a PASS because it means the evidence was not there.
 */
const SEVERITY: Record<VerdictStatus, number> = {
  FAIL: 3,
  INCONCLUSIVE: 2,
  PASS: 1,
  NOT_RUN: 0,
}

export function aggregateStatus(results: TestResult[]): VerdictStatus {
  if (results.length === 0) return "NOT_RUN"
  return results.reduce<VerdictStatus>(
    (worst, result) =>
      SEVERITY[result.status] > SEVERITY[worst] ? result.status : worst,
    "PASS"
  )
}

/** One row of the run report: a planned test case with the verdicts it produced. */
export interface CaseRow {
  tcId: string
  /** Verdict title when evaluated, else the test spec title, else the id. */
  title: string
  mnemonic: string | null
  status: VerdictStatus
  /** Empty for a case that has not been evaluated. */
  results: TestResult[]
}

export interface RunMetrics {
  /** Planned test cases (falls back to the cases that produced verdicts). */
  planned: number
  /** Cases with at least one verdict. */
  evaluated: number
  /** Case-level counts, keyed by aggregated verdict. */
  counts: Record<VerdictStatus, number>
  /**
   * PASS / (PASS + FAIL + INCONCLUSIVE) as a fraction, or null when nothing has
   * been evaluated. Never defaults to 0.
   *
   * The denominator deliberately matches `RunSummary.success_rate` on the
   * backend (`models_vmodel_chain.py`), which is the number the run list shows:
   * an inconclusive case is a case the run failed to demonstrate, so it counts
   * against the rate. If the two definitions drifted, the list and the detail
   * view would print different percentages for the same run.
   */
  passRate: number | null
}

export function emptyCounts(): Record<VerdictStatus, number> {
  return { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, NOT_RUN: 0 }
}

/**
 * Join planned test cases with the verdicts the run produced.
 *
 * Planned cases without a verdict become NOT_RUN rows - the honest state for a
 * run created in the Add Test Run dialog, whose MF4s have not been decoded yet.
 * A verdict for a case that is not in `plannedTcIds` is still shown, appended
 * after the planned ones, so nothing the backend returned is silently dropped.
 */
export function buildCaseRows(
  plannedTcIds: string[],
  results: TestResult[],
  specTitles: Map<string, { title: string; mnemonic: string | null }>
): CaseRow[] {
  const byTc = new Map<string, TestResult[]>()
  for (const result of results) {
    const bucket = byTc.get(result.tc_id)
    if (bucket) bucket.push(result)
    else byTc.set(result.tc_id, [result])
  }

  const ordered = [...plannedTcIds]
  for (const tcId of byTc.keys()) {
    if (!ordered.includes(tcId)) ordered.push(tcId)
  }

  return ordered.map((tcId) => {
    const tcResults = byTc.get(tcId) ?? []
    const spec = specTitles.get(tcId)
    return {
      tcId,
      title: tcResults[0]?.title || spec?.title || tcId,
      mnemonic: spec?.mnemonic ?? null,
      status: aggregateStatus(tcResults),
      results: tcResults,
    }
  })
}

export function computeMetrics(rows: CaseRow[]): RunMetrics {
  const counts = emptyCounts()
  for (const row of rows) counts[row.status] += 1

  const evaluated = rows.length - counts.NOT_RUN
  return {
    planned: rows.length,
    evaluated,
    counts,
    passRate: evaluated === 0 ? null : counts.PASS / evaluated,
  }
}

/** Verdict counts as reported on a run summary, in a stable order. */
export function summaryChips(
  counts: Partial<Record<VerdictStatus, number>>
): Array<{ status: VerdictStatus; count: number }> {
  return VERDICT_ORDER.map((status) => ({ status, count: counts[status] ?? 0 })).filter(
    (chip) => chip.count > 0
  )
}

export function totalCount(counts: Partial<Record<VerdictStatus, number>>): number {
  return VERDICT_ORDER.reduce((sum, status) => sum + (counts[status] ?? 0), 0)
}

/**
 * A run is "not evaluated" when nothing has produced a verdict for it yet.
 * The Add Test Run dialog creates exactly this: uploads attached, no traces
 * decoded, `counts` empty and `success_rate` null.
 *
 * `NOT_RUN` entries in `tc_counts` are ignored on purpose - a run where every
 * planned case is NOT_RUN has not been evaluated, whatever its case count says.
 */
export function isUnevaluated(run: RunSummaryPlus): boolean {
  if (totalCount(run.counts) > 0) return false
  const cases = run.tc_counts
  if (!cases) return true
  return (
    (cases.PASS ?? 0) + (cases.FAIL ?? 0) + (cases.INCONCLUSIVE ?? 0) === 0
  )
}

/**
 * The backend's `success_rate` is a 0-100 percentage and is null - never 0 -
 * when nothing has been evaluated. Rendering keeps that distinction.
 */
export function formatSuccessRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "not run yet"
  return `${rate.toFixed(1).replace(/\.0$/, "")}%`
}

/**
 * Same percentage, derived from counts. Used only as a fallback for a backend
 * that does not send `success_rate` yet, so the column never silently reads
 * "not run yet" for a run that plainly has verdicts.
 */
export function deriveSuccessRate(
  counts: Partial<Record<VerdictStatus, number>>
): number | null {
  const pass = counts.PASS ?? 0
  const denominator = pass + (counts.FAIL ?? 0) + (counts.INCONCLUSIVE ?? 0)
  return denominator === 0 ? null : (pass / denominator) * 100
}

/**
 * Newest first.
 *
 * Run ids are allocated sequentially (TR-0001 ... TR-0039), so the numeric
 * suffix is the only ordering key that works across both origins: seeded runs
 * carry no `created_utc` at all, planned runs do. Sorting on the timestamp
 * alone would scatter the seeded half of the list.
 */
export function runSequence(runId: string): number {
  const match = /(\d+)\s*$/.exec(runId)
  return match ? Number(match[1]) : -1
}

export function sortRunsNewestFirst<T extends { run_id: string }>(runs: T[]): T[] {
  return [...runs].sort((a, b) => {
    const delta = runSequence(b.run_id) - runSequence(a.run_id)
    return delta !== 0 ? delta : b.run_id.localeCompare(a.run_id)
  })
}

/**
 * Timestamps come back as ISO-8601 UTC ("2026-08-19T13:53:43Z"). They are
 * rendered as UTC, not localised: these are measurement timestamps and a
 * browser-local reinterpretation would silently shift them.
 */
export function formatUtc(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value)
  if (!match) return value
  return `${match[1]} ${match[2]} UTC`
}

/** Trim float noise without hiding a marginal miss (3.5157 vs a 3.5 bound). */
export function formatNumber(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  if (Number.isInteger(value)) return String(value)
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 4
  return value.toFixed(digits)
}

/** "3.516 <= 3.5 m/s^2" - the measured value against the bound it was judged by. */
export function formatMeasuredVsBound(result: TestResult): string | null {
  const measured = formatNumber(result.measured)
  const bound = formatNumber(result.bound)
  const unit = result.unit ? ` ${result.unit}` : ""

  if (measured === null && bound === null) return null
  if (measured === null) {
    return `no measured value (bound ${result.comparison ?? ""} ${bound}${unit})`.replace(
      /\s+/g,
      " "
    )
  }
  if (bound === null) return `${measured}${unit}`
  return `${measured} ${result.comparison ?? "vs"} ${bound}${unit}`
}

