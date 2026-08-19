"use client"

interface DetailSectionProps {
  title: string
  children: React.ReactNode
}

/**
 * A titled block in a detail pane. Deliberately plain: a small uppercase heading
 * and content. No Card, no border box - the user asked for technical content with
 * text and images, not decoration.
 */
export function DetailSection({ title, children }: DetailSectionProps) {
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
          <dd className="min-w-0 break-words">{row.value || <span className="text-muted-foreground">&mdash;</span>}</dd>
        </div>
      ))}
    </dl>
  )
}
