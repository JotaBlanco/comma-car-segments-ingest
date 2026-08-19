"use client"

/**
 * Coverage and execution donuts for the Test Results stage.
 *
 * Four headline rings - requirement coverage, requirements verified, tests
 * passed, tests not executed - plus one small ring per requirement family
 * (FUN / PRF / SAF). Everything is derived client-side from three existing read
 * endpoints; no new backend surface and no new dependency.
 *
 * Two rules govern the numbers:
 *
 * 1. **A metric with no denominator has no percentage.** `percent: null` renders
 *    an em dash and a plain-language caption, never a fabricated 0 %. That is the
 *    same rule `formatSuccessRate()` enforces in `results/verdict.ts`: a run that
 *    was never evaluated must not read as "everything failed".
 * 2. **A read that fails degrades to empty, it never blanks the page.** The three
 *    sources are fetched independently; a failure removes the rings that depend on
 *    it and states which source is missing.
 *
 * Charts are inline SVG (`stroke-dasharray` arcs) rather than a chart library:
 * `recharts` is not in `frontend/package.json` and adding it would need a
 * container rebuild. Colours come from the semantic theme tokens via
 * `currentColor`, so both themes are correct by construction.
 */

import { useEffect, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useVmRequirementsApi,
  useVmResultsApi,
  useVmTestSpecsApi,
} from "@/lib/hooks/use-api"
import { REQ_SEGMENT_CHAPTERS } from "@/lib/vmodel/constants"
import type { PaginatedResponse } from "@/types/pagination"
import type { Requirement, TestResult, TestSpec } from "@/types/vmodel"
import { aggregateStatus } from "./results/verdict"

/** Largest page size the backend accepts (PaginationParams.validate_page_size). */
const MAX_PAGE_SIZE = 200

/** Safety stop so a bad `total` can never spin a fetch loop forever. */
const MAX_PAGES = 10

/** Requirement families, in the order they are rendered. */
const FAMILIES = ["FUN", "PRF", "SAF"] as const

/* ------------------------------------------------------------------ *
 * Pure model
 * ------------------------------------------------------------------ */

type Tone = "success" | "destructive" | "warning" | "muted"

/**
 * Theme tokens, never hex. The ring paints with `currentColor`, so setting the
 * text colour of the `<circle>` is what colours the arc - and it stays correct in
 * both light and dark mode because both are defined in `app/globals.css`.
 */
const TONE_CLASS: Record<Tone, string> = {
  success: "text-success",
  destructive: "text-destructive",
  warning: "text-warning",
  muted: "text-muted-foreground",
}

/** One coloured arc of a ring. The unfilled remainder is the track, not a segment. */
interface DonutSegment {
  value: number
  tone: Tone
}

export interface DonutStat {
  id: string
  label: string
  /** 0-100, or null when the metric has no denominator. */
  percent: number | null
  /** The absolute counts behind the percentage, e.g. "9 / 37 requirements". */
  caption: string
  /** Optional longer text for the `title` tooltip. */
  hint?: string
  segments: DonutSegment[]
  /** Denominator the segments are drawn against. */
  total: number
}

export interface CoverageStats {
  headline: DonutStat[]
  families: DonutStat[]
}

/**
 * Length of an array-ish field, 0 for anything else.
 *
 * `covering_tc_ids` is declared on `RequirementDetail` but not on `Requirement`,
 * even though the list endpoint returns it; it arrives through the index
 * signature as `unknown`. Reading it defensively means this component is correct
 * both before and after the shared type gains the field, and correct while the
 * backend is still filling it in.
 */
function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function percentOf(value: number, total: number): number | null {
  if (total <= 0) return null
  return (value / total) * 100
}

/** The `FUN` / `PRF` / `SAF` segment of `ACC-SYS-FUN-001`. */
function requirementFamily(reqId: string): string | null {
  const parts = reqId.split("-")
  return parts.length > 2 ? parts[2] : null
}

/**
 * Everything the four headline rings and the three family rings need.
 *
 * The test-case universe is the union of the test specification register and any
 * test case that produced a verdict, so a verdict for an unplanned case is
 * counted rather than dropped. A case counts as executed when it has at least one
 * verdict that is not `NOT_RUN`; the worst verdict across its traces wins, using
 * the same `aggregateStatus()` the per-run report uses.
 */
export function computeCoverageStats(
  requirements: Requirement[],
  specs: TestSpec[],
  results: TestResult[]
): CoverageStats {
  const reqTotal = requirements.length
  const covered = requirements.filter(
    (req) => listLength(req.covering_tc_ids) > 0
  ).length
  const verified = requirements.filter((req) => listLength(req.verified_by) > 0).length

  const resultsByCase = new Map<string, TestResult[]>()
  for (const result of results) {
    const bucket = resultsByCase.get(result.tc_id)
    if (bucket) bucket.push(result)
    else resultsByCase.set(result.tc_id, [result])
  }

  const caseIds = new Set<string>(specs.map((spec) => spec.tc_id))
  for (const tcId of Array.from(resultsByCase.keys())) caseIds.add(tcId)

  let passed = 0
  let failed = 0
  let inconclusive = 0
  let executed = 0

  for (const tcId of Array.from(caseIds)) {
    const status = aggregateStatus(resultsByCase.get(tcId) ?? [])
    if (status === "NOT_RUN") continue
    executed += 1
    if (status === "PASS") passed += 1
    else if (status === "FAIL") failed += 1
    else inconclusive += 1
  }

  const caseTotal = caseIds.size
  const notExecuted = caseTotal - executed

  const headline: DonutStat[] = [
    {
      id: "coverage",
      label: "Requirement coverage",
      percent: percentOf(covered, reqTotal),
      caption: reqTotal > 0 ? `${covered} / ${reqTotal} requirements` : "no requirements",
      hint: "Requirements with at least one covering test case",
      segments: [{ value: covered, tone: "success" }],
      total: reqTotal,
    },
    {
      id: "verified",
      label: "Requirements verified",
      percent: percentOf(verified, reqTotal),
      caption: reqTotal > 0 ? `${verified} / ${reqTotal} requirements` : "no requirements",
      hint: "Requirements confirmed by a passing test case",
      segments: [{ value: verified, tone: "success" }],
      total: reqTotal,
    },
    {
      id: "passed",
      label: "Tests passed",
      percent: percentOf(passed, executed),
      caption: executed > 0 ? `${passed} / ${executed} executed` : "not run yet",
      hint: "Passing share of the test cases that produced a verdict",
      segments: [
        { value: passed, tone: "success" },
        { value: failed, tone: "destructive" },
        { value: inconclusive, tone: "warning" },
      ],
      total: executed,
    },
    {
      id: "not-executed",
      label: "Not executed",
      percent: percentOf(notExecuted, caseTotal),
      caption: caseTotal > 0 ? `${notExecuted} / ${caseTotal} test cases` : "no test cases",
      hint: "Test cases with no verdict yet",
      segments: [{ value: notExecuted, tone: "muted" }],
      total: caseTotal,
    },
  ]

  const families: DonutStat[] = FAMILIES.map((family) => {
    const inFamily = requirements.filter(
      (req) => requirementFamily(req.req_id) === family
    )
    const familyCovered = inFamily.filter(
      (req) => listLength(req.covering_tc_ids) > 0
    ).length
    const familyVerified = inFamily.filter(
      (req) => listLength(req.verified_by) > 0
    ).length

    // The ring reads verified, not covered. A family whose test cases exist but have
    // never run would otherwise show the same green as one that passed, which reads as
    // progress that has not happened - only the performance cases have been executed.
    // Coverage stays visible as the muted remainder so the distinction is on screen.
    return {
      id: family,
      label: family,
      percent: percentOf(familyVerified, inFamily.length),
      caption: `${familyVerified} / ${inFamily.length} verified`,
      hint: `${familyCovered} covered · ${REQ_SEGMENT_CHAPTERS[family] ?? family}`,
      segments: [
        { value: familyVerified, tone: "success" },
        { value: Math.max(familyCovered - familyVerified, 0), tone: "muted" },
      ],
      total: inFamily.length,
    }
  })

  return { headline, families }
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

interface SourceResult<T> {
  items: T[]
  ok: boolean
}

async function fetchAllPages<T>(
  load: (page: number) => Promise<PaginatedResponse<T>>
): Promise<SourceResult<T>> {
  try {
    const collected: T[] = []
    let page = 1

    while (page <= MAX_PAGES) {
      const data = await load(page)
      collected.push(...(data.items ?? []))

      const totalPages = data.total_pages ?? 1
      if (page >= totalPages || (data.items ?? []).length === 0) break
      page += 1
    }

    return { items: collected, ok: true }
  } catch {
    return { items: [], ok: false }
  }
}

interface CoverageState {
  stats: CoverageStats | null
  /** Human-readable names of the sources that could not be read. */
  missing: string[]
  loading: boolean
}

/**
 * Loads the three registers the rings are derived from, each tolerated
 * independently. All of them are small - 37 requirements, 9 test specifications,
 * a few hundred verdicts - so they are paged in fully and reduced client-side,
 * the same approach `use-vm-requirements.ts` and `use-run-list.ts` take.
 */
function useCoverageStats(): CoverageState {
  const vmRequirementsApi = useVmRequirementsApi()
  const vmTestSpecsApi = useVmTestSpecsApi()
  const vmResultsApi = useVmResultsApi()

  const [state, setState] = useState<CoverageState>({
    stats: null,
    missing: [],
    loading: true,
  })

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [requirements, specs, results] = await Promise.all([
        fetchAllPages<Requirement>((page) =>
          vmRequirementsApi.list({ page, page_size: MAX_PAGE_SIZE })
        ),
        fetchAllPages<TestSpec>((page) =>
          vmTestSpecsApi.list({ page, page_size: MAX_PAGE_SIZE })
        ),
        fetchAllPages<TestResult>((page) =>
          vmResultsApi.list({ page, page_size: MAX_PAGE_SIZE })
        ),
      ])

      if (cancelled) return

      const missing: string[] = []
      if (!requirements.ok) missing.push("requirements")
      if (!specs.ok) missing.push("test specifications")
      if (!results.ok) missing.push("verdicts")

      setState({
        stats:
          missing.length === 3
            ? null
            : computeCoverageStats(requirements.items, specs.items, results.items),
        missing,
        loading: false,
      })
    }

    load()

    return () => {
      cancelled = true
    }
    // The API clients are memoized per token; refetching on their identity would
    // loop. Same dependency shape as the other V-model read hooks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return state
}

/* ------------------------------------------------------------------ *
 * View
 * ------------------------------------------------------------------ */

const RADIUS = 42
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function formatPercent(percent: number | null): string {
  if (percent === null) return "–"
  return `${Math.round(percent)}%`
}

/**
 * One ring. Segments are laid out head to tail from twelve o'clock (the `-90deg`
 * rotation); the unpainted remainder shows the muted track underneath, which is
 * what makes "nothing executed yet" read as an empty ring rather than a full one.
 */
function Donut({ stat, size }: { stat: DonutStat; size: "lg" | "sm" }) {
  const large = size === "lg"
  const strokeWidth = large ? 10 : 12
  let consumed = 0

  return (
    <div
      className={`relative ${large ? "h-24 w-24" : "h-16 w-16"}`}
      role="img"
      aria-label={`${stat.label}: ${formatPercent(stat.percent)}, ${stat.caption}`}
    >
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle
          cx="50"
          cy="50"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted"
        />
        {stat.segments.map((segment) => {
          const fraction =
            stat.total > 0 ? Math.max(0, Math.min(1, segment.value / stat.total)) : 0
          if (fraction <= 0) return null

          const length = CIRCUMFERENCE * fraction
          const offset = -CIRCUMFERENCE * consumed
          consumed += fraction

          return (
            <circle
              key={segment.tone}
              cx="50"
              cy="50"
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              strokeLinecap="butt"
              strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
              strokeDashoffset={offset}
              className={TONE_CLASS[segment.tone]}
              style={{ transition: "stroke-dasharray 600ms ease-out" }}
            />
          )
        })}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span
          className={`font-semibold tabular-nums text-foreground ${
            large ? "text-xl" : "text-sm"
          }`}
        >
          {formatPercent(stat.percent)}
        </span>
      </div>
    </div>
  )
}

function DonutTile({ stat, size }: { stat: DonutStat; size: "lg" | "sm" }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center" title={stat.hint}>
      <Donut stat={stat} size={size} />
      <div className="space-y-0.5">
        <p
          className={`font-medium leading-tight text-foreground ${
            size === "lg" ? "text-sm" : "text-xs"
          }`}
        >
          {stat.label}
        </p>
        <p className="text-xs text-muted-foreground">{stat.caption}</p>
      </div>
    </div>
  )
}

function DonutsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 rounded-md border p-4 md:grid-cols-4">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex flex-col items-center gap-2">
          <Skeleton className="h-24 w-24 rounded-full" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}

/**
 * The summary band above the run register: what the requirement set is covered
 * and verified by, and how much of the test suite has actually run.
 */
export function CoverageDonuts() {
  const { stats, missing, loading } = useCoverageStats()

  if (loading) return <DonutsSkeleton />

  if (!stats) {
    return (
      <div className="flex items-center gap-2 rounded-md border p-4 text-sm text-muted-foreground">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        Coverage summary unavailable - the V-model registers could not be read.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 rounded-md border p-4 md:grid-cols-4">
        {stats.headline.map((stat) => (
          <DonutTile key={stat.id} stat={stat} size="lg" />
        ))}
      </div>

      <div className="rounded-md border p-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Requirement coverage by feature
        </p>
        <div className="grid grid-cols-3 gap-4 md:max-w-md">
          {stats.families.map((stat) => (
            <DonutTile key={stat.id} stat={stat} size="sm" />
          ))}
        </div>
      </div>

      {missing.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {missing.join(" and ")} could not be read; the figures above exclude them.
        </p>
      ) : null}
    </div>
  )
}
