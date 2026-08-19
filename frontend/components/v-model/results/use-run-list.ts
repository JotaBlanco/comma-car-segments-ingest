"use client"

/**
 * Hook for the Test Results run list.
 *
 * Same shape as `lib/hooks/use-vm-test-specs.ts`: plain fetch inside useEffect,
 * hand-rolled loading / error / refetch state, no React Query. The whole run
 * register is small (tens of runs) so it is paged in fully and every filter and
 * sort afterwards is client-side.
 */

import { useCallback, useEffect, useState } from "react"
import { useVmRunsApi } from "@/lib/hooks/use-api"
import type { PaginatedResponse } from "@/types/pagination"
import type { RunSummary } from "@/types/vmodel"
import { sortRunsNewestFirst, type RunSummaryPlus } from "./verdict"

/** Largest page size the backend accepts (PaginationParams.validate_page_size). */
const MAX_PAGE_SIZE = 200

/** Safety stop so a bad `total` can never spin the fetch loop forever. */
const MAX_PAGES = 25

export function useRunList() {
  const vmRunsApi = useVmRunsApi()
  const [runs, setRuns] = useState<RunSummaryPlus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function fetchRuns() {
      try {
        setLoading(true)
        setError(null)

        const collected: RunSummaryPlus[] = []
        let page = 1

        while (page <= MAX_PAGES) {
          const data: PaginatedResponse<RunSummary> = await vmRunsApi.list({
            page,
            page_size: MAX_PAGE_SIZE,
          })
          collected.push(...(data.items ?? []))

          const totalPages = data.total_pages ?? 1
          if (page >= totalPages || (data.items ?? []).length === 0) break
          page += 1
        }

        if (!cancelled) setRuns(sortRunsNewestFirst(collected))
      } catch (err) {
        if (!cancelled) {
          setRuns([])
          setError(err instanceof Error ? err : new Error("Failed to fetch test runs"))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchRuns()

    return () => {
      cancelled = true
    }
  }, [refetchTrigger])

  const refetch = useCallback(() => {
    setRefetchTrigger((prev) => prev + 1)
  }, [])

  return { runs, loading, error, refetch }
}
