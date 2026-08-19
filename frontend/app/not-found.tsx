"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"

/**
 * App-router 404.
 *
 * Without this file Next falls back to prerendering the pages-router `_error`
 * route, which renders through the root layout and therefore through
 * QuixAuthProvider — a client-only context that touches `window`. That fails
 * during static export and takes the whole build down with
 * "Error occurred prerendering page /404".
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        That page does not exist. The V-model chain starts at Requirements.
      </p>
      <Button asChild>
        <Link href="/requirements">Go to Requirements</Link>
      </Button>
    </div>
  )
}
