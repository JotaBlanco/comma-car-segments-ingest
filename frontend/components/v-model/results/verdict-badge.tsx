"use client"

import { Badge } from "@/components/ui/badge"
import type { VerdictStatus } from "@/types/vmodel"
import { summaryChips, VERDICT_LABEL, VERDICT_VARIANT } from "./verdict"

/** One verdict, rendered with the same colour everywhere in the stage. */
export function VerdictBadge({
  status,
  className,
}: {
  status: VerdictStatus
  className?: string
}) {
  return (
    <Badge variant={VERDICT_VARIANT[status]} className={className}>
      {VERDICT_LABEL[status]}
    </Badge>
  )
}

/**
 * Verdict counts as a row of chips. Zero-count verdicts are omitted, and a run
 * with no verdicts at all renders "not run yet" instead of a row of zeroes -
 * the state of every run created in the Add Test Run dialog.
 */
export function VerdictCounts({
  counts,
  emptyLabel = "not run yet",
}: {
  counts: Partial<Record<VerdictStatus, number>>
  emptyLabel?: string
}) {
  const chips = summaryChips(counts)

  if (chips.length === 0) {
    return <span className="text-xs text-muted-foreground">{emptyLabel}</span>
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Badge key={chip.status} variant={VERDICT_VARIANT[chip.status]}>
          {VERDICT_LABEL[chip.status]} {chip.count}
        </Badge>
      ))}
    </div>
  )
}
