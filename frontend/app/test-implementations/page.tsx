"use client"

import { useEffect, useState } from "react"
import { MainLayout } from "@/components/layout/main-layout"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useIntegrationsApi } from "@/lib/hooks/use-api"
import { useQuixAuth } from "@/lib/contexts/quix-auth-context"
import { Loader2 } from "lucide-react"

/**
 * Test Implementation — frames QuixLab, where the analysis scripts live.
 *
 * The URL comes from the backend (`/integrations/quixlab-url`), not from a
 * NEXT_PUBLIC_* variable: the frontend image is built once and deployed with
 * runtime variables, and Next inlines NEXT_PUBLIC values at build time, so one
 * set on the deployment would be undefined here. The other integration pages
 * (measurements, config-manager, analytics) fetch their URL the same way.
 *
 * No credential is passed to the iframe, deliberately. QuixLab is gated at the
 * Quix ingress rather than in the app: every path, including /health and
 * /openapi.json, answers 401 to a Bearer PAT, an SDK token, X-Api-Key, a cookie
 * we set, and to ?token= / ?pat= / ?access_token= query params. The gate wants a
 * Quix portal session cookie, which this page cannot mint, so a token in the URL
 * would buy nothing and only leak into history and referrer headers.
 *
 * Embedded in the portal (plugin.embeddedView) the browser already holds a
 * session cookie for *.testrig-depl.dev.quix.io, so a same-parent-domain iframe
 * sends it and QuixLab authenticates itself. QuixLab sets no X-Frame-Options and
 * no CSP frame-ancestors, so framing is not blocked. Opened standalone it will
 * show QuixLab's own 401 — the notice below says so rather than leaving a blank
 * panel.
 */
export default function TestImplementationsPage() {
  const integrationsApi = useIntegrationsApi()
  const { isEmbedded } = useQuixAuth()

  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    integrationsApi
      .getQuixlabUrl()
      .then(({ url }) => {
        if (!cancelled) setUrl(url)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err?.status === 501
              ? "QuixLab is not configured. Set QUIXLAB_URL on the backend deployment."
              : (err?.message ?? "Failed to load the QuixLab URL")
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [integrationsApi])

  if (loading) {
    return (
      <MainLayout>
        <div className="flex h-full items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading QuixLab…
        </div>
      </MainLayout>
    )
  }

  if (error || !url) {
    return (
      <MainLayout>
        <div className="p-6">
          <Alert>
            <AlertTitle>QuixLab unavailable</AlertTitle>
            <AlertDescription>{error ?? "No URL returned."}</AlertDescription>
          </Alert>
        </div>
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      <div className="flex h-full flex-col">
        {!isEmbedded && (
          <Alert className="m-4 mb-0">
            <AlertTitle>Open this from the Quix portal</AlertTitle>
            <AlertDescription>
              QuixLab authenticates with your Quix portal session. Viewed outside the
              portal it will show its own sign-in or a 401 below.
            </AlertDescription>
          </Alert>
        )}

        <iframe
          src={url}
          title="QuixLab"
          className="h-full w-full flex-1 border-0"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </MainLayout>
  )
}
