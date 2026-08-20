"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, Loader2 } from "lucide-react"
import { ExplorerShell } from "@/components/v-model/explorer-shell"
import { FilterBuilder } from "@/components/v-model/filter-builder"
import { ItemTree } from "@/components/v-model/item-tree"
import { TestSpecDetail } from "@/components/v-model/detail/test-spec-detail"
import { Skeleton } from "@/components/ui/skeleton"
import { useVmRequirements } from "@/lib/hooks/use-vm-requirements"
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
import {
  buildRequirementTitleIndex,
  buildRequirementVersionIndex,
  UNMAPPED_CHAPTER,
} from "@/lib/vmodel/test-specs"
import { buildTree } from "@/lib/vmodel/tree"
import type { TestSpec } from "@/types/vmodel"

/**
 * Test Specification - the second V-model stage.
 *
 * Same three-pane explorer as `/requirements`, and the same rules: every version
 * is loaded at once, there is no version selector, and `artifact_version` is an
 * ordinary filter attribute.
 *
 * The tree groups by CHAPTER, derived from `covers_req_ids[0]` (see
 * `lib/vmodel/test-specs.ts`). A test case has no chapter of its own, so it
 * inherits the chapter of the requirement it verifies - which puts a test case in
 * the same drawer as the requirement a reader came from.
 *
 * The requirements register is loaded alongside the specs for one reason: to
 * resolve each bare `covers_req_ids` entry to the versioned key the
 * `/requirements?select=` deep link expects.
 *
 * URL contract:
 *   ?select=<key>   the selected leaf, e.g. ACC-SYS-TC-001@v0001
 *   ?f=<base64>     the serialised filter, so a filtered view is shareable
 */
function TestSpecsPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const { testSpecs, loading, error } = useVmTestSpecs()
  const { requirements, loading: requirementsLoading } = useVmRequirements()

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
      router.replace(query ? `/test-specs?${query}` : "/test-specs", { scroll: false })
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

  const attributes = useMemo(() => deriveAttributes(testSpecs), [testSpecs])
  const filtered = useMemo(() => applyFilter(testSpecs, filter), [testSpecs, filter])
  const filterActive = useMemo(() => isFilterActive(filter), [filter])

  const versionIndex = useMemo(
    () => buildRequirementVersionIndex(requirements),
    [requirements]
  )
  const titleIndex = useMemo(
    () => buildRequirementTitleIndex(requirements),
    [requirements]
  )

  const tree = useMemo(
    () =>
      buildTree<TestSpec>(filtered, testSpecs, {
        levels: ["chapter"],
        leafId: (item) => item.key,
        leafLabel: (item) => ({ key: "", value: item.tc_id }),
        leafMeta: (item) => `rev ${item.revision} · ${item.artifact_version}`,
        levelOrder: { chapter: [...VMODEL_CHAPTERS, UNMAPPED_CHAPTER] },
      }),
    [filtered, testSpecs]
  )

  const selected = useMemo(
    () => filtered.find((item) => item.key === selectedKey) ?? null,
    [filtered, selectedKey]
  )

  const browser = useCallback(
    ({ onItemSelected }: { onItemSelected: () => void }) => (
      <>
        <FilterBuilder
          items={testSpecs}
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
              title="Test cases"
              root={tree}
              selectedItemId={selectedKey}
              onSelectItem={(itemId) => {
                handleSelect(itemId)
                onItemSelected()
              }}
              filterActive={filterActive}
              emptyMessage={
                testSpecs.length === 0
                  ? "No test specifications loaded."
                  : "No test specifications match the current filter."
              }
            />
          )}
        </div>
      </>
    ),
    [
      testSpecs,
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
      title="Test Specification"
      total={testSpecs.length}
      shown={filtered.length}
      browser={browser}
    >
      {loading ? (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading test specifications&hellip;
        </div>
      ) : error ? (
        <RegisterUnavailable message={error.message} />
      ) : testSpecs.length === 0 ? (
        <EmptyRegister />
      ) : (
        <TestSpecDetail
          spec={selected}
          versionIndex={versionIndex}
          titleIndex={titleIndex}
          requirementsLoading={requirementsLoading}
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
        <p className="text-sm font-medium">
          The test specification register is unavailable
        </p>
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="text-xs text-muted-foreground">
          GET /api/v1/vmodel/test-specs did not return a result. Seed the register, then
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
        <p className="text-sm font-medium">No test specifications loaded</p>
        <p className="text-sm text-muted-foreground">
          The register is empty. Once an artifact set is seeded or uploaded, every version
          of every test case appears here at once.
        </p>
      </div>
    </div>
  )
}

export default function TestSpecsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-screen w-full" />}>
      <TestSpecsPageContent />
    </Suspense>
  )
}
