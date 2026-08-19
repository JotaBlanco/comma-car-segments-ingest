"use client"

/**
 * Hook for the V-model test specification register.
 *
 * Same pattern as `use-vm-requirements.ts`: plain fetch inside useEffect with
 * hand-rolled loading / error / refetchTrigger state. No React Query, no SWR.
 *
 * The register is 9 documents, so the whole working set is loaded in one call and
 * every manipulation - filtering, grouping, the requirement reverse index -
 * happens client-side. That is also what makes the reverse link on the
 * Requirements page possible without a second endpoint.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useVmTestSpecsApi } from "./use-api"
import { withDerivedChapter } from "@/lib/vmodel/test-specs"
import type { TestSpec } from "@/types/vmodel"
import type { PaginatedResponse } from "@/types/pagination"

/** Largest page size the backend accepts (see PaginationParams.validate_page_size). */
const MAX_PAGE_SIZE = 200

/** Safety stop so a bad `total` can never spin the fetch loop forever. */
const MAX_PAGES = 25

export function useVmTestSpecs() {
  const vmTestSpecsApi = useVmTestSpecsApi()
  const [rawSpecs, setRawSpecs] = useState<TestSpec[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function fetchTestSpecs() {
      try {
        setLoading(true)
        setError(null)

        const collected: TestSpec[] = []
        let page = 1
        let totalItems = 0

        while (page <= MAX_PAGES) {
          const data: PaginatedResponse<TestSpec> = await vmTestSpecsApi.list({
            page,
            page_size: MAX_PAGE_SIZE,
          })

          collected.push(...(data.items ?? []))
          totalItems = data.total ?? collected.length

          const totalPages = data.total_pages ?? 1
          if (page >= totalPages || (data.items ?? []).length === 0) break
          page += 1
        }

        if (!cancelled) {
          setRawSpecs(collected)
          setTotal(totalItems || collected.length)
        }
      } catch (err) {
        if (!cancelled) {
          setRawSpecs([])
          setTotal(0)
          setError(
            err instanceof Error ? err : new Error("Failed to fetch test specifications")
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchTestSpecs()

    return () => {
      cancelled = true
    }
  }, [refetchTrigger])

  // `chapter` is derived, not returned by the backend. Deriving it once here
  // keeps it stable across renders and makes it an ordinary filter attribute.
  const testSpecs = useMemo(() => withDerivedChapter(rawSpecs), [rawSpecs])

  const refetch = useCallback(() => {
    setRefetchTrigger((prev) => prev + 1)
  }, [])

  return { testSpecs, total, loading, error, refetch }
}
