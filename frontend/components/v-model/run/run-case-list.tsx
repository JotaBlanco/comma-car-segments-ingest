"use client"

import Link from "next/link"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils/cn"
import { VerdictBadge } from "@/components/v-model/results/verdict-badge"
import type { CaseRow } from "@/components/v-model/results/verdict"

interface RunCaseListProps {
  rows: CaseRow[]
  className?: string
}

/**
 * The test cases in a run, one line each, with no measurements or charts.
 *
 * The detailed cards below answer "why did this fail". This answers the question
 * asked first and far more often - "what is in this run, and did it pass" - which
 * previously meant scrolling three tall cards to read three verdicts.
 *
 * Each row links to the test case on the Test Specification page. A run stores
 * only the test case id, not the artifact version it was planned against, so the
 * link carries the bare id; that page resolves a bare `tc_id` as well as a
 * versioned `key` for exactly this reason.
 */
export function RunCaseList({ rows, className }: RunCaseListProps) {
  if (rows.length === 0) return null

  return (
    <div className={cn("divide-y overflow-hidden rounded-md border", className)}>
      {rows.map((row) => (
        <Link
          key={row.tcId}
          href={`/test-specs?select=${encodeURIComponent(row.tcId)}`}
          className="group flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-foreground/5"
          title={`Open ${row.tcId} in Test Specification`}
        >
          <VerdictBadge status={row.status} className="shrink-0" />
          <span className="shrink-0 font-mono text-xs text-foreground">{row.tcId}</span>
          {/* The title yields before the id does: the id is what identifies the row. */}
          <span className="min-w-0 truncate text-muted-foreground">{row.title}</span>
          <ChevronRight
            className="ml-auto h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        </Link>
      ))}
    </div>
  )
}
