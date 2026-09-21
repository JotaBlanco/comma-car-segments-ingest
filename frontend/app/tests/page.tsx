"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, Loader2 } from "lucide-react"

import { ExplorerShell } from "@/components/v-model/explorer-shell"
import { FilterBuilder } from "@/components/v-model/filter-builder"
import { ItemTree } from "@/components/v-model/item-tree"
import { AddTestRunDialog } from "@/components/v-model/add-test-run-dialog"
import { useRunList } from "@/components/v-model/results/use-run-list"
import { Placeholder, RunDetailPanel } from "@/components/v-model/run/run-detail-panel"
import {
  RUN_STATUS_GROUP_ORDER,
  compareRunsNewestFirst,
  runLeafMeta,
  withStatusGroup,
  type RunRow,
} from "@/components/v-model/run/run-groups"
import { Skeleton } from "@/components/ui/skeleton"
import {
  applyFilter,
  decodeFilter,
  deriveAttributes,
  encodeFilter,
  isFilterActive,
  EMPTY_FILTER,
  type FilterState,
} from "@/lib/vmodel/filter"
import { buildTree } from "@/lib/vmodel/tree"
import type { RunSummary } from "@/types/vmodel"

/**
 * Test Run - the fourth V-model stage.
 *
 * The same master/detail explorer as `/requirements` and `/test-specs`, and for
 * the same reason: runs on the left, the selected run's test cases on the right.
 * There is no second view and no view switch. The page had a Runs / All tests
 * toggle and it is gone - a Test Run page shows runs, and the Phase 2 bench-test
 * records are reached through `/tests/[id]`, `/tests/add` and `/tests/[id]/edit`,
 * which are unchanged.
 *
 * Clicking a run opens it. That is the whole of the fix for "runs cannot be
 * opened": a run row is a tree leaf, selecting it writes `?select=<run_id>` and
 * the right pane renders that run's verdicts. The URL is the state, so a run view
 * is shareable and the browser back button works.
 *
 * URL contract:
 *   ?select=<run_id>   the selected run, e.g. TR-0001
 *   ?run=<run_id>      accepted as a legacy alias of ?select=
 *   ?f=<base64>        the serialised filter, so a filtered view is shareable
 */
function TestRunPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // The whole register is small (tens of runs) and is paged in fully, so every
  // filter and every count below is client-side. Shared with `/test-results` so
  // both stages list the same runs in the same order.
  const { runs, loading, error, refetch } = useRunList()

  // `run` was the parameter the previous list surface used. Reading it as an alias
  // keeps any bookmark or link that still carries it working.
  const selectedRunId = searchParams.get("select") ?? searchParams.get("run")
  const encodedFilter = searchParams.get("f")

  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER)
  const [addOpen, setAddOpen] = useState(false)

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
      router.replace(query ? `/tests?${query}` : "/tests", { scroll: false })
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
      // Written to `select` only: the legacy `run` alias is read, never produced.
      updateSearchParams({ select: itemId, run: null })
    },
    [updateSearchParams]
  )

  // A run that was just created or just started is selected as well as refetched:
  // after pressing Add or Run, the thing you want to look at is that run.
  const handleRunChanged = useCallback(
    (run: RunSummary) => {
      handleSelect(run.run_id)
      refetch()
    },
    [handleSelect, refetch]
  )

  const rows = useMemo(() => withStatusGroup(runs), [runs])
  const attributes = useMemo(() => deriveAttributes(rows), [rows])
  const filtered = useMemo(() => applyFilter(rows, filter), [rows, filter])
  const filterActive = useMemo(() => isFilterActive(filter), [filter])

  const tree = useMemo(
    () =>
      buildTree<RunRow>(filtered, rows, {
        levels: ["status_group"],
        leafId: (item) => item.run_id,
        leafLabel: (item) => ({ key: "", value: item.run_id }),
        leafMeta: (item) => runLeafMeta(item),
        levelOrder: { status_group: RUN_STATUS_GROUP_ORDER },
        leafCompare: compareRunsNewestFirst,
      }),
    [filtered, rows]
  )

  // Resolved against the unfiltered set on purpose: a deep link to a run that the
  // current filter hides still renders, rather than showing an empty pane.
  const selectedRun = useMemo(
    () => rows.find((item) => item.run_id === selectedRunId) ?? null,
    [rows, selectedRunId]
  )

  const browser = useCallback(
    ({ onItemSelected }: { onItemSelected: () => void }) => (
      <>
        <FilterBuilder
          items={rows}
          attributes={attributes}
          value={filter}
          onChange={handleFilterChange}
        />
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {loading && rows.length === 0 ? (
            <div className="space-y-2 px-3 py-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-36" />
            </div>
          ) : (
            <ItemTree
              title="Test runs"
              root={tree}
              selectedItemId={selectedRunId}
              onSelectItem={(itemId) => {
                handleSelect(itemId)
                onItemSelected()
              }}
              filterActive={filterActive}
              // Three status groups, not 37 chapters: collapsing them by default
              // would hide every run behind a click.
              expandGroups
              emptyMessage={
                rows.length === 0
                  ? "No test runs yet."
                  : "No test run matches the current filter."
              }
            />
          )}
        </div>
      </>
    ),
    [
      rows,
      attributes,
      filter,
      handleFilterChange,
      loading,
      tree,
      selectedRunId,
      handleSelect,
      filterActive,
    ]
  )

  return (
    <ExplorerShell
      title="Test Run"
      total={rows.length}
      shown={filtered.length}
      browser={browser}
      onAdd={() => setAddOpen(true)}
    >
      <AddTestRunDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={handleRunChanged}
      />

      {loading && rows.length === 0 ? (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading test runs&hellip;
        </div>
      ) : error ? (
        <RegisterUnavailable message={error.message} />
      ) : rows.length === 0 ? (
        <Placeholder
          title="No test runs yet"
          body="Add Test Run picks the test cases to run and creates one. It appears here immediately, marked as not run until its measurements are evaluated."
        />
      ) : selectedRunId && !selectedRun ? (
        <Placeholder
          title={`${selectedRunId} is not in the register`}
          body="The run in the URL does not exist. Pick one from the tree on the left."
        />
      ) : (
        <RunDetailPanel runId={selectedRunId} onRunChanged={handleRunChanged} />
      )}
    </ExplorerShell>
  )
}

/** The runs endpoint is not reachable - say so plainly, never crash. */
function RegisterUnavailable({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md space-y-2 text-center">
        <AlertTriangle
          className="mx-auto h-5 w-5 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-sm font-medium">The test run register is unavailable</p>
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="text-xs text-muted-foreground">
          GET /api/v1/vmodel/runs did not return a result. Check the backend, then reload
          this page.
        </p>
      </div>
    </div>
  )
}

export default function TestsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-screen w-full" />}>
      <TestRunPageContent />
    </Suspense>
  )
}
