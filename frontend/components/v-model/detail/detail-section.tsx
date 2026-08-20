"use client"

import { ChevronRight } from "lucide-react"

interface DetailSectionProps {
  title: string
  children: React.ReactNode
  /**
   * If true, wraps the section in a native <details>/<summary> element so the
   * user can collapse it. The browser manages toggle state; no JS or dependency
   * is needed beyond the HTML primitive.
   */
  collapsible?: boolean
  /**
   * Whether the collapsible section starts open. Defaults to false (collapsed).
   * Only used when collapsible=true.
   */
  defaultOpen?: boolean
  /**
   * One-line description shown on the closed disclosure header so the section
   * remains scannable without opening. Hidden automatically when open.
   * Principle: Nielsen #2 (match between system and real world) — a bare
   * "Notes" label gives no context; "Notes — provenance and remarks" does.
   */
  closedSummary?: string
}

/**
 * A titled block in a detail pane.
 *
 * Non-collapsible: a small uppercase heading and its content. No Card, no
 * border box — the user asked for technical content, not decoration.
 *
 * Collapsible: wraps in native <details>/<summary>. The chevron rotates via
 * the Tailwind group-open: variant. The closedSummary text is hidden via
 * group-open:hidden when the section is expanded (less noise when reading).
 */
export function DetailSection({
  title,
  children,
  collapsible,
  defaultOpen = false,
  closedSummary,
}: DetailSectionProps) {
  if (collapsible) {
    return (
      <details className="group" open={defaultOpen}>
        <summary className="flex cursor-pointer items-center gap-1.5 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="h-3 w-3 shrink-0 transition-transform duration-150 group-open:rotate-90"
            aria-hidden="true"
          />
          <span>{title}</span>
          {closedSummary && (
            <span className="ml-1 truncate font-normal normal-case tracking-normal text-muted-foreground/60 group-open:hidden">
              &mdash; {closedSummary}
            </span>
          )}
        </summary>
        <div className="mt-2 space-y-2">{children}</div>
      </details>
    )
  }

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

interface DefinitionGridProps {
  /** Rows are rendered in the order given; a null/empty value renders an em dash. */
  rows: { label: string; value: React.ReactNode }[]
}

/** Two-column definition grid: label column fixed, value column fluid. */
export function DefinitionGrid({ rows }: DefinitionGridProps) {
  return (
    <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words">
            {row.value || <span className="text-muted-foreground">&mdash;</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}
