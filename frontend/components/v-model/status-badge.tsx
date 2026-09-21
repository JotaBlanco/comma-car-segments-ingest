"use client"

import { Badge } from "@/components/ui/badge"
import type { RequirementStatus } from "@/types/vmodel"
import { RETIRED_REQUIREMENT_STATUSES } from "@/types/vmodel"

interface StatusBadgeProps {
  status: RequirementStatus | string
}

/**
 * Requirement lifecycle status. All five values are in use and `Obsolete` /
 * `Rejected` items stay visible and findable - they are marked retired, never
 * hidden and never filtered out by default.
 */
export function StatusBadge({ status }: StatusBadgeProps) {
  const retired = RETIRED_REQUIREMENT_STATUSES.includes(status as RequirementStatus)

  const variant =
    status === "Approved"
      ? "success"
      : status === "Reviewed"
        ? "info"
        : retired
          ? "outline"
          : "secondary"

  return (
    <Badge variant={variant} className={retired ? "line-through decoration-1" : undefined}>
      {status}
    </Badge>
  )
}
