/**
 * Pure helpers for the Test Run explorer - no React, no DOM.
 *
 * Two jobs, both of which exist so the tree and the detail panel cannot disagree:
 *
 * 1. Turn a `RunSummary` into a tree item: a derived `status_group` label the
 *    tree groups by, and the one-line meta a run row shows on the right.
 * 2. Join the per-case verdicts the backend rolled up (`/runs/{id}/summary`)
 *    with the verdict documents (`/results?run_id=`) that carry the measured
 *    value and its bound.
 *
 * Verdict formatting, colours, the worst-verdict rule and the newest-first
 * ordering are imported from `components/v-model/results/verdict.ts` rather than
 * restated here. That module is pure and belongs to the Test Results stage;
 * sharing it is deliberate, so `/tests` and `/test-results` can never print a
 * different success rate, a different measured-vs-bound string or a different
 * verdict colour for the same run.
 */

import {
  RUN_STATUS_LABEL,
  aggregateStatus,
  type CaseRow,
} from "@/components/v-model/results/verdict"
import type {
  RunSummary,
  RunTestCaseSummary,
  TestResult,
  VerdictStatus,
} from "@/types/vmodel"

/**
 * A run as the tree and the filter builder see it.
 *
 * The index signature is what `buildTree` and `applyFilter` require: every field
 * of a run is a filterable attribute, exactly as on the other stage pages.
 */
export interface RunRow extends RunSummary {
  /** Display label of the execution status - the level the tree groups by. */
  status_group: string
  [key: string]: unknown
}

/**
 * Group order in the tree.
 *
 * Not lifecycle order. The two states someone acts on come first, failures next,
 * and the archive of finished runs last - a register that is mostly `completed`
 * would otherwise bury the run that was just planned.
 */
export const RUN_STATUS_GROUP_ORDER = [
  "Running",
  "Planned",
  "Error",
  "Completed",
] as const

/** Group label of one run; an unknown state keeps its raw value rather than vanishing. */
export function statusGroupOf(run: RunSummary): string {
  return RUN_STATUS_LABEL[run.status] ?? run.status
}

/**
 * Add the derived `status_group` field.
 *
 * Written onto the item rather than passed into the tree builder, which is the
 * standing rule for this feature (see `withDerivedChapter` in
 * `lib/vmodel/test-specs.ts`): a derived field is an ordinary filter attribute too.
 */
export function withStatusGroup(runs: RunSummary[]): RunRow[] {
  // The assertion is the index signature and nothing else: `RunSummary` is an
  // interface, and TypeScript does not widen an interface into an indexable type
  // on its own. Every declared field is present in the spread.
  return runs.map((run) => ({ ...run, status_group: statusGroupOf(run) }) as RunRow)
}

/** Cases of a run that carry a verdict. `tc_counts` always sums to the planned count. */
function evaluatedCount(counts: Partial<Record<VerdictStatus, number>>): number {
  return (counts.PASS ?? 0) + (counts.FAIL ?? 0) + (counts.INCONCLUSIVE ?? 0)
}

/**
 * The right-aligned meta of a run row: `4/9 pass`.
 *
 * The denominator is the number of *evaluated* cases, not the planned count, so a
 * run where 2 of 9 cases have been measured reads `1/2 pass` rather than `1/9` -
 * a case nobody measured is not a failure. A run with no verdicts at all says so
 * in words; it never renders `0/0` or `0%`, because `success_rate` is null there
 * and "not run" must not be readable as "everything failed".
 */
export function runLeafMeta(run: RunSummary): string {
  const evaluated = evaluatedCount(run.tc_counts)
  if (evaluated === 0) {
    return run.planned_tc_ids.length === 0 ? "no cases" : "not run"
  }
  return `${run.tc_counts.PASS ?? 0}/${evaluated} pass`
}

/** The numeric suffix of a run id - the only ordering key both origins share. */
function runSequence(runId: string): number {
  const match = /(\d+)\s*$/.exec(runId)
  return match ? Number(match[1]) : -1
}

/**
 * Newest first, for the leaves of one group.
 *
 * Run ids are allocated sequentially (`TR-0001` ... `TR-0039`) and seeded runs
 * carry no `created_utc` at all, so sorting on the timestamp would scatter half
 * the register.
 */
export function compareRunsNewestFirst(a: RunSummary, b: RunSummary): number {
  const delta = runSequence(b.run_id) - runSequence(a.run_id)
  return delta !== 0 ? delta : b.run_id.localeCompare(a.run_id)
}

/**
 * Join the summary's planned test cases with the verdict documents of the run.
 *
 * The verdict on each row is the backend's (`vm_run_summary.py`: worst verdict
 * wins across traces), never re-derived here, so the rows cannot contradict the
 * counts in the header. The result documents are attached only for what they add
 * that the summary does not carry: the measured value, the bound, the margin and
 * the per-criterion breakdown.
 *
 * A verdict for a case the summary does not list is appended rather than dropped -
 * that is a run whose planned set changed after evaluation, and hiding it would
 * hide evidence.
 */
export function buildRunCaseRows(
  testCases: RunTestCaseSummary[],
  results: TestResult[]
): CaseRow[] {
  const byTc = new Map<string, TestResult[]>()
  for (const result of results) {
    const bucket = byTc.get(result.tc_id)
    if (bucket) bucket.push(result)
    else byTc.set(result.tc_id, [result])
  }

  const rows: CaseRow[] = testCases.map((testCase) => ({
    tcId: testCase.tc_id,
    title: testCase.title || testCase.tc_id,
    // The summary carries no mnemonic, and the id is already on the row.
    mnemonic: null,
    status: testCase.status,
    results: byTc.get(testCase.tc_id) ?? [],
  }))

  const planned = new Set(testCases.map((testCase) => testCase.tc_id))
  for (const [tcId, tcResults] of byTc) {
    if (planned.has(tcId)) continue
    rows.push({
      tcId,
      title: tcResults[0]?.title || tcId,
      mnemonic: null,
      status: aggregateStatus(tcResults),
      results: tcResults,
    })
  }

  return rows
}
