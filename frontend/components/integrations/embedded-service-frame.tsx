"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"

import { MainLayout } from "@/components/layout/main-layout"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useQuixAuth } from "@/lib/contexts/quix-auth-context"

interface EmbeddedServiceFrameProps {
  /** Human name of the service, used in the loading and error copy. */
  title: string
  /** Resolves the URL to frame. Always a backend call - see the note below. */
  fetchUrl: () => Promise<{ url: string }>
  /** Shown when the backend answers 501, i.e. the URL variable is unset. */
  notConfiguredMessage: string
}

/**
 * Frames an external Quix service as a full-height page.
 *
 * Extracted from the Test Implementation page once a third page needed the same
 * behaviour. Three things in here are not obvious and were each a bug first:
 *
 * THE URL COMES FROM THE BACKEND, never from a NEXT_PUBLIC_* variable. The
 * frontend image is built once and deployed with runtime variables, and Next
 * inlines NEXT_PUBLIC values at build time, so one set on the deployment reads
 * as undefined here.
 *
 * NO CREDENTIAL IS PUT IN THE URL. These services are gated at the Quix ingress
 * rather than in the app: every path answers 401 to a Bearer PAT, an SDK token,
 * X-Api-Key, and to ?token= / ?pat= / ?access_token=. The gate wants a Quix
 * portal session cookie, which this page cannot mint. Embedded in the portal the
 * browser already holds one for *.testrig-depl.dev.quix.io, so a same-parent-
 * domain iframe sends it and the service authenticates itself. Opened standalone
 * it shows the service's own 401.
 *
 * THE TOKEN HANDSHAKE IS ANSWERED ANYWAY. QuixLab is built to be framed by the
 * portal, which performs an embedded-plugin handshake; framed from here that
 * never happens and QuixLab falls back to prompting for a PAT. The convention is
 * {type:"REQUEST_AUTH_TOKEN"} up and {type:"AUTH_TOKEN", token} down. We answer
 * on request and post once on load, because a frame that listens without asking
 * would otherwise never be served.
 */
export function EmbeddedServiceFrame({
  title,
  fetchUrl,
  notConfiguredMessage,
}: EmbeddedServiceFrameProps) {
  const { token } = useQuixAuth()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetchUrl()
      .then(({ url }) => {
        if (!cancelled) setUrl(url)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err?.status === 501
              ? notConfiguredMessage
              : (err?.message ?? `Failed to load the ${title} URL`)
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // fetchUrl comes from a hook and is stable per render of the caller; adding
    // it here would refetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        console.log(`[${title}] unhandled message from frame:`, event.data.type, event.data)
      }
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [url, token, title])

  if (loading) {
    return (
      <MainLayout>
        <div className="flex h-full items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading {title}…
        </div>
      </MainLayout>
    )
  }

  if (error || !url) {
    return (
      <MainLayout>
        <div className="p-6">
          <Alert>
            <AlertTitle>{title} unavailable</AlertTitle>
            <AlertDescription>{error ?? "No URL returned."}</AlertDescription>
          </Alert>
        </div>
      </MainLayout>
    )
  }

  return (
    <MainLayout noPadding>
      {/* MainLayout has min-h-screen rather than a definite height and <main> has
          none, so h-full collapses to content height. 4rem matches header h-16. */}
      <iframe
        ref={iframeRef}
        src={url}
        title={title}
        onLoad={() => {
          if (token) {
            iframeRef.current?.contentWindow?.postMessage(
              { type: "AUTH_TOKEN", token },
              "*"
            )
          }
        }}
        className="w-full h-[calc(100vh-4rem)] border-0"
        allow="clipboard-read; clipboard-write"
      />
    </MainLayout>
  )
}
