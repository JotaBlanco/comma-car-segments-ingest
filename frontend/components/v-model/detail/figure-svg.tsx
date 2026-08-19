"use client"

import { useEffect, useState } from "react"

import { apiGetText } from "@/lib/api/client"
import { useQuixAuth } from "@/lib/contexts/quix-auth-context"

interface FigureSvgProps {
  /** Endpoint path relative to /api/v1, e.g. "/vmodel/figures/F3". */
  endpoint: string
  title: string
}

/**
 * Renders a figure by fetching its SVG with the auth token and inlining it.
 *
 * An <img src> tag cannot send an Authorization header, so against a backend
 * with API_AUTH_ACTIVE the request 403s and the browser shows a broken image.
 * That is invisible locally, where auth is bypassed, and only appears once
 * deployed.
 *
 * Inlining also fixes a second problem: these figures set color="#111827" on
 * the root and draw most of their structure with currentColor, which is
 * near-invisible on a dark background. As inline markup the CSS colour below
 * overrides that presentation attribute, so the diagram follows the theme.
 */
export function FigureSvg({ endpoint, title }: FigureSvgProps) {
  const { token, refreshToken } = useQuixAuth()
  const [markup, setMarkup] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    apiGetText(endpoint, undefined, token, refreshToken)
      .then((svg) => {
        if (!cancelled) setMarkup(svg)
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? "Failed to load figure")
      })

    return () => {
      cancelled = true
    }
  }, [endpoint, token, refreshToken])

  if (error) {
    return (
      <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
        {title} could not be loaded ({error})
      </div>
    )
  }

  if (!markup) {
    return <div className="h-48 w-full max-w-2xl animate-pulse rounded border bg-muted/40" />
  }

  return (
    <div
      role="img"
      aria-label={title}
      className="w-full max-w-2xl rounded border bg-background p-2 text-foreground [&_svg]:h-auto [&_svg]:w-full"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
