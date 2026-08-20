"use client"

import { useState } from "react"
import Link from "next/link"
import { ChevronRight, ExternalLink } from "lucide-react"

import { cn } from "@/lib/utils/cn"
import { CaseResultCard } from "@/components/v-model/results/case-result-card"
import { VerdictBadge } from "@/components/v-model/results/verdict-badge"
import type { CaseRow } from "@/components/v-model/results/verdict"

interface RunCaseListProps {
  rows: CaseRow[]
  className?: string
}

/**
 * The test cases in a run: one line each, expandable to the full result.
 *
 * Collapsed, it answers the question asked first and far more often - "what is in
 * this run, and did it pass" - which used to mean scrolling three tall cards to
 * read three verdicts. Expanding a row reveals that row's measurements, criteria
 * and charts in place, so the details are reached from the list rather than living
 * in a second stack below it.
 *
 * Two separate targets on each row, deliberately: the row body toggles the detail,
 * and the arrow icon on the right opens the test case on the Test Specification
 * page. A single target could only do one of the two, and both are wanted. The link
 * is a real anchor rather than a click handler so it still middle-clicks and
 * copies. It also stops propagation, or following it would expand the row on the
 * way out.
 *
 * A run stores only the test case id, not the artifact version it was planned
 * against, so the link carries the bare id; the Test Specification page resolves a
 * bare `tc_id` as well as a versioned `key` for exactly this reason.
 */
export function RunCaseList({ rows, className }: RunCaseListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  if (rows.length === 0) return null

  const toggle = (tcId: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(tcId)) {
        next.delete(tcId)
      } else {
        next.add(tcId)
      }
      return next
    })

  return (
    <div className={cn("divide-y overflow-hidden rounded-md border", className)}>
      {rows.map((row) => {
        const open = expanded.has(row.tcId)

        return (
          <div key={row.tcId}>
            <div
              className={cn(
                "flex items-center gap-3 px-3 py-2 text-sm transition-colors",
                open ? "bg-foreground/5" : "hover:bg-foreground/5"
              )}
            >
              <button
                type="button"
                onClick={() => toggle(row.tcId)}
                aria-expanded={open}
                aria-controls={`case-detail-${row.tcId}`}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                title={open ? "Hide result" : "Show result"}
              >
                <ChevronRight
                  className={cn(
                    "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-100",
                    open && "rotate-90"
                  )}
                  aria-hidden="true"
                />
                <VerdictBadge status={row.status} className="shrink-0" />
                <span className="shrink-0 font-mono text-xs text-foreground">
                  {row.tcId}
                </span>
                {/* The title yields before the id does: the id identifies the row. */}
                <span className="min-w-0 truncate text-muted-foreground">
                  {row.title}
                </span>
              </button>

              <Link
                href={`/test-specs?select=${encodeURIComponent(row.tcId)}`}
                onClick={(event) => event.stopPropagation()}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                title={`Open ${row.tcId} in Test Specification`}
                aria-label={`Open ${row.tcId} in Test Specification`}
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>

            {open && (
              <div id={`case-detail-${row.tcId}`} className="border-t bg-background p-3">
                <CaseResultCard row={row} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
