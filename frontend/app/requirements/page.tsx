"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, Loader2 } from "lucide-react"
import { ExplorerShell } from "@/components/v-model/explorer-shell"
import { FilterBuilder } from "@/components/v-model/filter-builder"
import { ItemTree } from "@/components/v-model/item-tree"
import { RequirementDetail } from "@/components/v-model/detail/requirement-detail"
import { Skeleton } from "@/components/ui/skeleton"
import { useVmRequirement, useVmRequirements } from "@/lib/hooks/use-vm-requirements"
import { useVmTestSpecs } from "@/lib/hooks/use-vm-test-specs"
import { VMODEL_CHAPTERS } from "@/lib/vmodel/constants"
import {
  applyFilter,
  decodeFilter,
  deriveAttributes,
  encodeFilter,
  isFilterActive,
  EMPTY_FILTER,
  type FilterState,
} from "@/lib/vmodel/filter"
import { buildCoveringSpecIndex, coveringSpecsFor } from "@/lib/vmodel/test-specs"
import { buildTree } from "@/lib/vmodel/tree"
import type { Requirement } from "@/types/vmodel"

/**
 * Requirements - the first V-model stage.
 *
 * Everything the register holds is loaded once and every version is shown at the
 * same time. There is deliberately no version selector and no baseline picker
 * anywhere on this page: `artifact_version` is an ordinary filter attribute like
 * any other, and `Obsolete` / `Rejected` requirements stay visible and findable.
 *
 * URL contract:
 *   ?select=<key>   the selected leaf, e.g. ACC-SYS-PRF-020@v0003
 *   ?f=<base64>     the serialised filter, so a filtered view is shareable
 */
function RequirementsPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const { requirements, loading, error } = useVmRequirements()

  // Loaded only to answer "what verifies this requirement?". The reverse index is
  // built client-side by inverting `covers_req_ids[]` across the 9 specs - there is
  // no coverage endpoint behind this, and `verified_by[]` is deliberately not used.
  const {
    testSpecs,
    loading: testSpecsLoading,
    error: testSpecsError,
  } = useVmTestSpecs()

  const selectedKey = searchParams.get("select")
  const encodedFilter = searchParams.get("f")

  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER)

  // Seed the filter from the URL once the param is known (shareable filtered views).
  useEffect(() => {
    const decoded = decodeFilter(encodedFilter)
    if (decoded) {
      setFilter(decoded)
    }
    // Only re-seed when the URL blob itself changes, not on every local edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encodedFilter])

  const updateSearchParams = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") {
          params.delete(key)
        } else {
          params.set(key, value)
        }
      }
      const query = params.toString()
      router.replace(query ? `/requirements?${query}` : "/requirements", {
        scroll: false,
      })
    },
    [router, searchParams]
  )

  const handleFilterChange = useCallback(
    (next: FilterState) => {
      setFilter(next)
      updateSearchParams({ f: next.rows.length > 0 ? encodeFilter(next) : null })
    },
    [updateSearchParams]
  )

  const handleSelect = useCallback(
    (itemId: string) => {
      updateSearchParams({ select: itemId })
    },
    [updateSearchParams]
  )

  const attributes = useMemo(() => deriveAttributes(requirements), [requirements])
  const filtered = useMemo(() => applyFilter(requirements, filter), [requirements, filter])
  const filterActive = useMemo(() => isFilterActive(filter), [filter])

  const tree = useMemo(
    () =>
      buildTree<Requirement>(filtered, requirements, {
        levels: ["chapter"],
        leafId: (item) => item.key,
        leafLabel: (item) => ({ key: "", value: item.req_id }),
        leafMeta: (item) => `rev ${item.revision} · ${item.artifact_version}`,
        levelOrder: { chapter: VMODEL_CHAPTERS },
      }),
    [filtered, requirements]
  )

  const summary = useMemo(
    () => filtered.find((item) => item.key === selectedKey) ?? null,
    [filtered, selectedKey]
  )

  const coveringSpecIndex = useMemo(() => buildCoveringSpecIndex(testSpecs), [testSpecs])
  const coveringSpecs = useMemo(
    () => coveringSpecsFor(coveringSpecIndex, summary?.req_id),
    [coveringSpecIndex, summary]
  )

  // Only fetch enriched detail for a leaf that actually exists in the working set.
  const { requirement: detail, loading: detailLoading, error: detailError } =
    useVmRequirement(summary ? summary.key : null)

  const browser = useCallback(
    ({ onItemSelected }: { onItemSelected: () => void }) => (
      <>
        <FilterBuilder
          items={requirements}
          attributes={attributes}
          value={filter}
          onChange={handleFilterChange}
        />
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {loading ? (
            <div className="space-y-2 px-3 py-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-36" />
            </div>
          ) : (
            <ItemTree
              root={tree}
              selectedItemId={selectedKey}
              onSelectItem={(itemId) => {
                handleSelect(itemId)
                onItemSelected()
              }}
              filterActive={filterActive}
              emptyMessage={
                requirements.length === 0
                  ? "No requirements loaded."
                  : "No requirements match the current filter."
              }
            />
          )}
        </div>
      </>
    ),
    [
      requirements,
      attributes,
      filter,
      handleFilterChange,
      loading,
      tree,
      selectedKey,
      handleSelect,
      filterActive,
    ]
  )

  return (
    <ExplorerShell
      title="Requirements"
      total={requirements.length}
      shown={filtered.length}
      browser={browser}
    >
      {loading ? (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading requirements&hellip;
        </div>
      ) : error ? (
        <RegisterUnavailable message={error.message} />
      ) : requirements.length === 0 ? (
        <EmptyRegister />
      ) : (
        <RequirementDetail
          summary={summary}
          detail={detail}
          detailLoading={detailLoading}
          detailError={detailError}
          coveringSpecs={coveringSpecs}
          coveringSpecsLoading={testSpecsLoading}
          coveringSpecsUnavailable={Boolean(testSpecsError)}
        />
      )}
    </ExplorerShell>
  )
}

/** The register endpoint is not reachable - say so plainly, never crash. */
function RegisterUnavailable({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md space-y-2 text-center">
        <AlertTriangle
          className="mx-auto h-5 w-5 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-sm font-medium">The requirements register is unavailable</p>
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="text-xs text-muted-foreground">
          GET /api/v1/vmodel/requirements did not return a result. Seed the register, then
          reload this page.
        </p>
      </div>
    </div>
  )
}

/** Reachable but empty - a different, non-alarming state. */
function EmptyRegister() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md space-y-2 text-center">
        <p className="text-sm font-medium">No requirements loaded</p>
        <p className="text-sm text-muted-foreground">
          The register is empty. Once an artifact set is seeded or uploaded, every version
          of every requirement appears here at once.
        </p>
      </div>
    </div>
  )
}

export default function RequirementsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-screen w-full" />}>
      <RequirementsPageContent />
    </Suspense>
  )
}
