import { NextResponse } from "next/server"

/**
 * Runtime lookup of the MF4 upload service base URL.
 *
 * WHY THIS ROUTE EXISTS: `NEXT_PUBLIC_*` variables are inlined by `npm run build`,
 * so a value set only on the deployed container (Quix deployment variables are
 * runtime, not build-time - see frontend/dockerfile, which passes just API_URL as a
 * build arg) would never reach the browser bundle. This route reads the variable in
 * the Node process at request time, which works in both local dev and production.
 *
 * `MF4_UPLOAD_URL` is the variable to set. `NEXT_PUBLIC_MF4_UPLOAD_URL` still works
 * as a build-time override and takes precedence client-side.
 *
 * Only the rewrite `/api/v1/:path*` is proxied to the backend (next.config.js), so
 * this path stays inside Next.js and never collides with a backend route.
 */
export const dynamic = "force-dynamic"

export function GET() {
  const baseUrl =
    process.env.MF4_UPLOAD_URL ?? process.env.NEXT_PUBLIC_MF4_UPLOAD_URL ?? null

  return NextResponse.json({ base_url: baseUrl ? baseUrl.replace(/\/+$/, "") : null })
}
