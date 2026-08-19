"use client"

import { useEffect, useRef, useState } from "react"
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
  const { token } = useQuixAuth()
  const iframeRef = useRef<HTMLIFrameElement>(null)

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

  /**
   * Answer QuixLab's token request, the way the portal answers ours.
   *
   * QuixLab is built to be framed by the Quix portal via its own sidebar item,
   * where the portal performs the embedded-plugin auth handshake. Framed from
   * here that handshake never happens, so QuixLab falls back to prompting for a
   * PAT - which is why it works for whoever opened it from the Quix sidebar and
   * prompts everyone else.
   *
   * The platform convention is {type:"REQUEST_AUTH_TOKEN"} up and
   * {type:"AUTH_TOKEN", token} down; quix-auth-context.tsx speaks exactly that
   * to our own parent. We both answer on request and post once on load, since
   * a child that listens without asking would otherwise never be served. Any
   * other message from the frame is logged so we can see what it really wants.
   */
  useEffect(() => {
    if (!url || !token) return

    const send = () => {
      iframeRef.current?.contentWindow?.postMessage({ type: "AUTH_TOKEN", token }, "*")
    }

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "REQUEST_AUTH_TOKEN") {
        send()
        return
      }
      if (event.data?.type && event.data.type !== "AUTH_TOKEN") {
        console.log("[QuixLab] unhandled message from frame:", event.data.type, event.data)
      }
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [url, token])

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

        <iframe
          ref={iframeRef}
          src={url}
          title="QuixLab"
          onLoad={() => {
            if (token) {
              iframeRef.current?.contentWindow?.postMessage(
                { type: "AUTH_TOKEN", token },
                "*"
              )
            }
          }}
          className="h-full w-full flex-1 border-0"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </MainLayout>
  )
}
