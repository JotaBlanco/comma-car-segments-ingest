"use client"

import { Suspense, useState, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import nextDynamic from "next/dynamic"
import { SortingState } from "@tanstack/react-table"
import { MainLayout } from "@/components/layout/main-layout"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { TestRunStage } from "@/components/v-model/test-run-stage"

// Lazy load TestsTable to reduce initial bundle size
const TestsTable = nextDynamic(() => import("@/components/tests/tests-table").then((mod) => ({ default: mod.TestsTable })), {
  loading: () => <Skeleton className="h-96 w-full" />,
  ssr: false,
})
import { TestsFilters } from "@/components/tests/tests-filters"
import { EmptyState } from "@/components/shared/empty-state"
import { Pagination } from "@/components/shared/pagination"
import { useTests } from "@/lib/hooks/use-tests"
import { TestStatus } from "@/types/test"
import { FileText } from "lucide-react"

/**
 * The Test Run stage of the V-model chain.
 *
 * Two views, and the default is the one that answers "did it pass":
 *
 * - **Runs** (default) - `GET /vmodel/runs`, with per-run status, verdicts, requirement
 *   coverage and success rate. This is the surface the V-model spec calls Test Run.
 * - **All tests** - the Phase 2 bench-test table, filters and pagination, unchanged.
 *   Kept because `/tests/[id]`, `/tests/add` and `/tests/[id]/edit` still exist and are
 *   still the way a bench test is managed; it is simply no longer the landing view.
 */
function TestsPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [view, setView] = useState<"runs" | "tests">("runs")

  // Get filters from URL
  const [filters, setFilters] = useState({
    status: searchParams.get("status") as TestStatus | undefined,
    environment_id: searchParams.get("environment_id") || undefined,
    campaign_id: searchParams.get("campaign_id") || undefined,
    q: searchParams.get("q") || undefined,
  })

  const [sorting, setSorting] = useState<SortingState>([{ id: "created_at", desc: true }])

  // Fetch tests with filters and pagination
  const {
    tests,
    loading,
    error,
    refetch,
    page,
    pageSize,
    total,
    totalPages,
    goToPage,
    changePageSize,
  } = useTests(filters)

  // Handle filter changes and update URL
  const handleFilterChange = useCallback((key: string, value: string | undefined) => {
    const newFilters = { ...filters, [key]: value }
    setFilters(newFilters)

    // Update URL params
    const params = new URLSearchParams()
    Object.entries(newFilters).forEach(([k, v]) => {
      if (v) params.set(k, v)
    })
    router.push(`/tests?${params.toString()}`)
  }, [filters, router])

  const handleClearFilters = useCallback(() => {
    setFilters({
      status: undefined,
      environment_id: undefined,
      campaign_id: undefined,
      q: undefined,
    })
    router.push("/tests")
  }, [router])

  return (
    <MainLayout>
      <div className="max-w-7xl space-y-4">
        {/* View switch. Two plain buttons rather than a tab component: the stages are
            routes, and this is the only place in the chain with a second view. */}
        <div className="flex gap-2">
          <Button
            variant={view === "runs" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("runs")}
          >
            Runs
          </Button>
          <Button
            variant={view === "tests" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("tests")}
          >
            All tests
          </Button>
        </div>

        {view === "runs" ? (
          <TestRunStage initialRunId={searchParams.get("run")} />
        ) : (
          <div className="space-y-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">All tests</h1>
              <p className="text-muted-foreground">
                Every test record, including bench tests that are not V-model runs
              </p>
            </div>

            {/* Filters */}
            <TestsFilters
              filters={filters}
              onFilterChange={handleFilterChange}
              onClearFilters={handleClearFilters}
            />

            {/* Table or Loading/Error States */}
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : error ? (
              <EmptyState
                icon={<FileText className="h-12 w-12" />}
                title="Failed to load tests"
                description={error.message}
                action={{
                  label: "Retry",
                  onClick: refetch,
                }}
              />
            ) : tests.length === 0 ? (
              <EmptyState
                icon={<FileText className="h-12 w-12" />}
                title="No tests found"
                description="No tests match your current filters. Try adjusting your search criteria."
                action={
                  Object.values(filters).some((v) => v)
                    ? {
                        label: "Clear Filters",
                        onClick: handleClearFilters,
                      }
                    : undefined
                }
              />
            ) : (
              <>
                <TestsTable data={tests} sorting={sorting} onSortingChange={setSorting} />
                {total > 0 && (
                  <Pagination
                    page={page}
                    pageSize={pageSize}
                    total={total}
                    totalPages={totalPages}
                    onPageChange={goToPage}
                    onPageSizeChange={changePageSize}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </MainLayout>
  )
}

export default function TestsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen"><div>Loading...</div></div>}>
      <TestsPageContent />
    </Suspense>
  )
}
