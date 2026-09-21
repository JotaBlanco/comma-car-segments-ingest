"use client"

import { useState } from "react"

interface TruncatedTextProps {
  text: string
  /** Maximum characters before truncation. Defaults to 300. */
  maxLength?: number
  className?: string
}

/**
 * Renders a paragraph of free text. If the text exceeds maxLength characters,
 * it is truncated with an ellipsis and a "show more" button inline. Expanding
 * reveals the full text with a "show less" button. No content is removed — the
 * full text is always reachable.
 *
 * Principle: long free-text paragraphs push critical content below the fold.
 * Truncation respects visual hierarchy (Nielsen #8: aesthetic and minimalist
 * design) by surfacing the first paragraph-equivalent of prose and letting the
 * reader opt in to the rest.
 */
export function TruncatedText({ text, maxLength = 300, className }: TruncatedTextProps) {
  const [expanded, setExpanded] = useState(false)
  const needsTruncation = text.length > maxLength

  if (!needsTruncation || expanded) {
    return (
      <p className={className}>
        {text}
        {needsTruncation && (
          <>
            {" "}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              show less
            </button>
          </>
        )}
      </p>
    )
  }

  return (
    <p className={className}>
      {text.slice(0, maxLength)}
      <span className="text-muted-foreground">&hellip;</span>{" "}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-xs text-primary underline-offset-2 hover:underline"
      >
        show more
      </button>
    </p>
  )
}
