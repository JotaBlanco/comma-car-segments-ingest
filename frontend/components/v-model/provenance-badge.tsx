"use client"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils/cn"
import { UNVERIFIED_TAG } from "@/lib/vmodel/constants"

/** Reads the tag as what it is - the provenance of the requirement text. */
const SOURCE_LABEL: Record<string, string> = {
  "VERIFIED-PRIMARY": "primary",
  "VERIFIED-SECONDARY": "secondary",
  DERIVED: "derived",
  "UNVERIFIED-2018": "unconfirmed (2018)",
}

interface ProvenanceBadgeProps {
  verificationTag: string
  className?: string
}

/**
 * The `verification_tag`. The brief calls it the single most important qualifier
 * on a requirement in this register, so provenance is never buried: it renders in
 * the tree row meta AND in the detail header.
 *
 * It is prefixed `source:` and stripped of the word VERIFIED because it describes
 * where the requirement TEXT came from, not whether the requirement has been tested.
 * Rendered raw, `VERIFIED-PRIMARY` sat on requirements with no test case at all and
 * read as a pass. Test evidence is `verified_by`, and it is shown by CoverageBadge.
 *
 * `UNVERIFIED-2018` keeps its distinct amber treatment; every other tag is secondary.
 */
export function ProvenanceBadge({ verificationTag, className }: ProvenanceBadgeProps) {
  if (!verificationTag) return null

  const unverified = verificationTag === UNVERIFIED_TAG
  const source = SOURCE_LABEL[verificationTag] ?? verificationTag.toLowerCase()

  return (
    <Badge
      variant={unverified ? "outline" : "secondary"}
      className={cn(
        unverified && "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        className
      )}
      title={
        unverified
          ? "The requirement text could not be confirmed against a 2018 source - treat the value as provisional. Says nothing about testing."
          : "Where the requirement text came from. Whether it has been tested is shown separately."
      }
    >
      source: {source}
    </Badge>
  )
}
