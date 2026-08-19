"use client"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils/cn"
import { UNVERIFIED_TAG } from "@/lib/vmodel/constants"

interface ProvenanceBadgeProps {
  verificationTag: string
  className?: string
}

/**
 * The `verification_tag`. The brief calls it the single most important qualifier
 * on a requirement in this register, so provenance is never buried: it renders in
 * the tree row meta AND in the detail header.
 *
 * `UNVERIFIED-2018` gets a distinct amber treatment; every other tag is secondary.
 */
export function ProvenanceBadge({ verificationTag, className }: ProvenanceBadgeProps) {
  if (!verificationTag) return null

  const unverified = verificationTag === UNVERIFIED_TAG

  return (
    <Badge
      variant={unverified ? "outline" : "secondary"}
      className={cn(
        unverified && "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        className
      )}
      title={
        unverified
          ? "Not verified against a 2018 source - treat the value as provisional"
          : undefined
      }
    >
      {verificationTag}
    </Badge>
  )
}
