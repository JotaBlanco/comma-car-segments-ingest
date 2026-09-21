"use client"

/**
 * Hook for one run's result view.
 *
 * Four reads make the report, and they are deliberately independent:
 *   GET /vmodel/runs/{id}          the run itself - the only hard dependency
 *   GET /vmodel/runs/{id}/traces   the measurement files, `[]` on a planned run
 *   GET /vmodel/results?run_id=..  the verdicts, empty until the run is evaluated
 *   GET /vmodel/runs/{id}/series   the plot data, `[]` until the run is executed
 *
 * Test specifications are pulled once as well, purely to give a title to a
 * planned test case that has no verdict yet - a verdict carries its own title,
 * a not-run case does not.
 *
 * Only the run read is fatal. Empty traces and empty verdicts are the normal
 * state of a freshly created run and are reported as "not run yet", never as an
 * error and never as a 0% score.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  useVmResultsApi,
  useVmRunsApi,
  useVmTestSpecsApi,
} from "@/lib/hooks/use-api"
import type { PaginatedResponse } from "@/types/pagination"
import type { CaseSeries } from "@/types/vm-execution"
import type { TestResult, TestSpec, Trace } from "@/types/vmodel"
import { indexSeries } from "./series"
import {
  buildCaseRows,
  computeMetrics,
  type CaseRow,
  type RunMetrics,
  type RunSummaryPlus,
} from "./verdict"

const MAX_PAGE_SIZE = 200
const MAX_PAGES = 25

export interface RunReport {
  run: RunSummaryPlus | null
  traces: Trace[]
  results: TestResult[]
  rows: CaseRow[]
  metrics: RunMetrics
  /** Plot data per test case id. Empty for a run that has not been executed. */
  series: Map<string, CaseSeries>
  loading: boolean
  error: Error | null
  refetch: () => void
}

export function useRunReport(runId: string): RunReport {
  const vmRunsApi = useVmRunsApi()
  const vmResultsApi = useVmResultsApi()
  const vmTestSpecsApi = useVmTestSpecsApi()

  const [run, setRun] = useState<RunSummaryPlus | null>(null)
  const [traces, setTraces] = useState<Trace[]>([])
  const [results, setResults] = useState<TestResult[]>([])
  const [specs, setSpecs] = useState<TestSpec[]>([])
  const [seriesDocs, setSeriesDocs] = useState<CaseSeries[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  useEffect(() => {
    if (!runId) return
    let cancelled = false

    /**
     * Page through the verdicts of one run. The unfiltered result set is 333
     * documents, so it is never loaded whole - `run_id` always narrows it first.
     * Defined inline so it closes over the memoised, token-bound api object.
     */
    async function fetchAllResults(): Promise<TestResult[]> {
      const collected: TestResult[] = []
      let page = 1

      while (page <= MAX_PAGES) {
        const data: PaginatedResponse<TestResult> = await vmResultsApi.list({
          run_id: runId,
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

    async function fetchReport() {
      try {
        setLoading(true)
        setError(null)

        // The run is the only fatal read: without it there is nothing to show.
        const runData = await vmRunsApi.get(runId)
        if (cancelled) return
        setRun(runData)

        const [traceData, resultData, specData, seriesData] = await Promise.all([
          vmRunsApi.traces(runId).catch(() => [] as Trace[]),
          fetchAllResults().catch(() => [] as TestResult[]),
          vmTestSpecsApi
            .list({ page: 1, page_size: MAX_PAGE_SIZE })
            .then((page: PaginatedResponse<TestSpec>) => page.items ?? [])
            .catch(() => [] as TestSpec[]),
          // Tolerated like the rest: a run that has never been executed has no
          // series, and the report then shows verdicts without charts.
          vmRunsApi.series(runId).catch(() => [] as CaseSeries[]),
        ])

        if (cancelled) return
        setTraces(traceData ?? [])
        setResults(resultData)
        setSpecs(specData)
        setSeriesDocs(seriesData ?? [])
      } catch (err) {
        if (!cancelled) {
          setRun(null)
          setTraces([])
          setResults([])
          setSeriesDocs([])
          setError(
            err instanceof Error ? err : new Error(`Failed to load run ${runId}`)
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchReport()

    return () => {
      cancelled = true
    }
  }, [runId, refetchTrigger])

  const specTitles = useMemo(() => {
    const index = new Map<string, { title: string; mnemonic: string | null }>()
    for (const spec of specs) {
      // Specs arrive one document per version; the first one wins, which is
      // enough for a display title.
      if (!index.has(spec.tc_id)) {
        index.set(spec.tc_id, { title: spec.title, mnemonic: spec.mnemonic ?? null })
      }
    }
    return index
  }, [specs])

  const rows = useMemo(
    () => buildCaseRows(run?.planned_tc_ids ?? [], results, specTitles),
    [run, results, specTitles]
  )

  const metrics = useMemo(() => computeMetrics(rows), [rows])

  const series = useMemo(() => indexSeries(seriesDocs), [seriesDocs])

  const refetch = useCallback(() => {
    setRefetchTrigger((prev) => prev + 1)
  }, [])

  return { run, traces, results, rows, metrics, series, loading, error, refetch }
}

