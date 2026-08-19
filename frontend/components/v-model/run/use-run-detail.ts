"use client"

/**
 * Hook for the right pane of the Test Run explorer: one run, its planned test
 * cases and their verdicts.
 *
 * Two reads, and only the first is fatal:
 *   GET /vmodel/runs/{id}/summary   the run, every planned case with its verdict,
 *                                  the requirement coverage and the success rate
 *   GET /vmodel/results?run_id=..   the verdict documents, purely to add the
 *                                   measured value, the bound and the criteria
 *
 * The summary is the source of truth for the verdicts because the rollup rules
 * (worst verdict wins per case, a case with no verdict is NOT_RUN, `success_rate`
 * is null rather than 0) live server-side in `backend/api/vm_run_summary.py`. The
 * results are decoration on top of it: an empty result set is the normal state of
 * a planned run and is never an error and never a zero score.
 *
 * Fetching follows the established pattern of `results/use-run-report.ts` and
 * `lib/hooks/use-vm-test-specs.ts` - plain fetch in `useEffect`, hand-rolled
 * loading / error / refetch state, a cancel flag, no React Query.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useVmResultsApi, useVmRunsApi } from "@/lib/hooks/use-api"
import type { PaginatedResponse } from "@/types/pagination"
import type { RunDetailSummary, TestResult } from "@/types/vmodel"
import type { CaseRow } from "@/components/v-model/results/verdict"
import { buildRunCaseRows } from "./run-groups"

/** Largest page size the backend accepts (PaginationParams.validate_page_size). */
const MAX_PAGE_SIZE = 200

/** Safety stop so a bad `total_pages` can never spin the fetch loop forever. */
const MAX_PAGES = 25

export interface RunDetail {
  summary: RunDetailSummary | null
  /** Planned cases with their verdict and, where evaluated, their measurements. */
  rows: CaseRow[]
  loading: boolean
  error: Error | null
  refetch: () => void
}

export function useRunDetail(runId: string | null): RunDetail {
  const vmRunsApi = useVmRunsApi()
  const vmResultsApi = useVmResultsApi()

  const [summary, setSummary] = useState<RunDetailSummary | null>(null)
  const [results, setResults] = useState<TestResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  useEffect(() => {
    if (!runId) {
      setSummary(null)
      setResults([])
      setError(null)
      // A selection cleared mid-fetch must not leave the pane spinning.
      setLoading(false)
      return
    }
    let cancelled = false

    /**
     * Page through the verdicts of one run. The unfiltered result set is hundreds
     * of documents, so `run_id` always narrows it first. Defined inline so it
     * closes over the memoised, token-bound api object.
     */
    async function fetchAllResults(id: string): Promise<TestResult[]> {
      const collected: TestResult[] = []
      let page = 1

      while (page <= MAX_PAGES) {
        const data: PaginatedResponse<TestResult> = await vmResultsApi.list({
          run_id: id,
          page,
          page_size: MAX_PAGE_SIZE,
        })
        collected.push(...(data.items ?? []))

        const totalPages = data.total_pages ?? 1
        if (page >= totalPages || (data.items ?? []).length === 0) break
        page += 1
      }

      return collected
    }

    async function fetchDetail(id: string) {
      try {
        setLoading(true)
        setError(null)

        // The summary is the only fatal read: without it there is no run to show.
        const summaryData = await vmRunsApi.summary(id)
        if (cancelled) return
        setSummary(summaryData)

        // Missing verdicts are a state, not a failure - fall back to none.
        const resultData = await fetchAllResults(id).catch(() => [] as TestResult[])
        if (cancelled) return
        setResults(resultData)
      } catch (err) {
        if (!cancelled) {
          setSummary(null)
          setResults([])
          setError(
            err instanceof Error ? err : new Error(`Failed to load run ${id}`)
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchDetail(runId)

    return () => {
      cancelled = true
    }
  }, [runId, refetchTrigger])

  const rows = useMemo(
    () => buildRunCaseRows(summary?.test_cases ?? [], results),
    [summary, results]
  )

  const refetch = useCallback(() => {
    setRefetchTrigger((previous) => previous + 1)
  }, [])

  return { summary, rows, loading, error, refetch }
}
