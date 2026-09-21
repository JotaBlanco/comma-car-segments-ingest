"use client"

/**
 * Hooks for the V-model requirements register.
 *
 * Follows the established repo pattern: plain fetch inside useEffect with
 * hand-rolled loading / error / refetchTrigger state. No React Query, no SWR.
 *
 * The register is small (~111 rows across all versions), so the list hook loads
 * the whole working set in one call and every manipulation - filtering, grouping,
 * counting - happens client-side. That is what makes "all versions visible at
 * once, no version selector" cheap. See open-questions.md Q6: this must move
 * server-side past roughly 5000 rows.
 */

import { useCallback, useEffect, useState } from "react"
import { useVmRequirementsApi } from "./use-api"
import type { Requirement, RequirementDetail } from "@/types/vmodel"
import type { PaginatedResponse } from "@/types/pagination"

/**
 * Largest page the backend accepts: `PaginationParams.validate_page_size` allows
 * only [10, 20, 50, 100, 200] and 422s/500s on anything else. The register is
 * fetched page-by-page at this size until the whole working set is in memory.
 */
const MAX_PAGE_SIZE = 200

/** Safety stop so a bad `total` can never spin the fetch loop forever. */
const MAX_PAGES = 25

export function useVmRequirements() {
  const vmRequirementsApi = useVmRequirementsApi()
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function fetchRequirements() {
      try {
        setLoading(true)
        setError(null)

        const collected: Requirement[] = []
        let page = 1
        let totalItems = 0

        // Walk every page so the tree and the filter always see the complete
        // working set - all versions at once, which is what makes "no version
        // selector anywhere" possible.
        while (page <= MAX_PAGES) {
          const data: PaginatedResponse<Requirement> = await vmRequirementsApi.list({
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
          setRequirements(collected)
          setTotal(totalItems || collected.length)
        }
      } catch (err) {
        if (!cancelled) {
          setRequirements([])
          setTotal(0)
          setError(
            err instanceof Error ? err : new Error("Failed to fetch requirements")
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchRequirements()

    return () => {
      cancelled = true
    }
  }, [refetchTrigger])

  const refetch = useCallback(() => {
    setRefetchTrigger((prev) => prev + 1)
  }, [])

  return { requirements, total, loading, error, refetch }
}

/**
 * Full detail for one requirement version, including resolved figures and the
 * versions/baselines it appears in.
 *
 * @param key "{req_id}@{artifact_version}" or null when nothing is selected.
 */
export function useVmRequirement(key: string | null) {
  const vmRequirementsApi = useVmRequirementsApi()
  const [requirement, setRequirement] = useState<RequirementDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!key) {
      setRequirement(null)
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false

    async function fetchRequirement() {
      try {
        setLoading(true)
        setError(null)
        const data = await vmRequirementsApi.get(key!)

        if (!cancelled) {
          setRequirement(data)
        }
      } catch (err) {
        if (!cancelled) {
          setRequirement(null)
          setError(
            err instanceof Error ? err : new Error("Failed to fetch requirement")
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchRequirement()

    return () => {
      cancelled = true
    }
  }, [key])

  return { requirement, loading, error }
}
