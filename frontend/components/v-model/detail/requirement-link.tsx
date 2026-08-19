"use client"

import Link from "next/link"
import { cn } from "@/lib/utils/cn"
import { requirementHref, requirementKeyFor } from "@/lib/vmodel/test-specs"

interface RequirementLinkProps {
  /** BARE requirement id as stored on the test spec, e.g. "ACC-SYS-FUN-005". */
  reqId: string
  /** Bare id -> current artifact version, from `buildRequirementVersionIndex()`. */
  versionIndex: Map<string, string>
  /** Requirement title, rendered after the id in `chip` mode when known. */
  title?: string
  variant?: "chip" | "inline"
  className?: string
}

/**
 * A link from a test specification to the requirement it verifies.
 *
 * This is the whole point of the Test Specification page, and it has one sharp
 * edge: `covers_req_ids[]` holds the BARE id (`ACC-SYS-FUN-005`) while the
 * requirement's own key is versioned (`ACC-SYS-FUN-005@v0001`), and the
 * `?select=` deep link matches on the versioned key. The version is resolved
 * from the loaded requirements register.
 *
 * When the register does not know the id - it failed to load, or the test spec
 * points at a requirement that was never ingested - the id renders as plain
 * text. A link that silently selects nothing would be worse than no link.
 */
export function RequirementLink({
  reqId,
  versionIndex,
  title,
  variant = "chip",
  className,
}: RequirementLinkProps) {
  const key = requirementKeyFor(reqId, versionIndex)

  if (!key) {
    return (
      <span
        className={cn("font-mono text-xs text-muted-foreground", className)}
        title="Not in the loaded requirements register - no link target"
      >
        {reqId}
      </span>
    )
  }

  if (variant === "inline") {
    return (
      <Link
        href={requirementHref(key)}
        className={cn("font-mono text-xs underline-offset-2 hover:underline", className)}
      >
        {reqId}
      </Link>
    )
  }

  return (
    <Link
      href={requirementHref(key)}
      className={cn(
        "inline-flex items-baseline gap-2 rounded-full border px-2.5 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground",
        className
      )}
      title={title}
    >
      <span className="font-mono text-xs">{reqId}</span>
      {title && <span className="max-w-xs truncate text-xs">{title}</span>}
    </Link>
  )
}
