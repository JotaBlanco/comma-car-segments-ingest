"use client";

import { useEffect, useRef, useState } from "react";
import { getActivePortalToken } from "@/lib/portal/token-store";
import { MAX_QUIXLAB_SIGNALS } from "@/lib/quixlab";
import { cn } from "@/lib/utils";

/** The two message names QuixLab sends up, and the two this frame sends down. */
const REQUEST_AUTH_TOKEN = "REQUEST_AUTH_TOKEN";
const AUTH_TOKEN = "AUTH_TOKEN";
const REQUEST_TM_IMPORT = "REQUEST_TM_IMPORT";
const TM_IMPORT = "TM_IMPORT";

/** The pick a caller passes nothing for. One constant, so it holds still. */
const WHOLE_RUN: readonly string[] = [];

/**
 * The QuixLab frame, and the handshake that gives it a session and a run.
 *
 * Two screens mount it: the `/quixlab` page, which frames the workspace
 * QuixLab with no run, and the run detail panel, which frames a picked
 * instance on one run. Both pass the instance's `embed_url` and its `origin`.
 *
 * The whole message dance lives in one effect, so the listener and the `src`
 * start in one order and stop together.
 */
export function QuixLabFrame({
  embedUrl,
  origin,
  title = "QuixLab",
  runId = "",
  signals = WHOLE_RUN,
  fill = false,
}: {
  /** The address the frame loads. */
  embedUrl: string;
  /** The `targetOrigin` of every message posted down, and the only origin answered. */
  origin: string;
  /** The iframe's accessible name. */
  title?: string;
  /** The run the frame opens. Empty frames QuixLab on nothing in particular. */
  runId?: string;
  /** The signal names a person picked, or an empty list for the whole run. */
  signals?: readonly string[];
  /** True while the frame fills its container. It changes classes only. */
  fill?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  /* True while QuixLab has asked for a token and this browser holds none. It is
     not an error: QuixLab keeps asking, and it shows its own sign-in form. The
     note below says so, instead of leaving a person with a blank frame. */
  const [waitingForToken, setWaitingForToken] = useState(false);

  /* The pick lives in a ref, and the listener reads it when it answers.
     The effect below sets `src`, so putting the pick in that effect's
     dependencies would reload the frame on every tick of a checkbox and drop
     the QuixLab session. This is the same rule the token already follows:
     read at reply time, never capture at mount. */
  const signalsRef = useRef(signals);
  useEffect(() => {
    signalsRef.current = signals;
  }, [signals]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // The origin check is first and it is the whole point. Any page can post
      // a well-shaped message; only the browser sets `event.origin`.
      if (event.origin !== origin) return;
      const data = event.data as { type?: unknown } | null;
      if (typeof data !== "object" || data === null) return;

      if (data.type === REQUEST_AUTH_TOKEN) {
        /* Read the token NOW, never at mount. QuixLab asks again 60 s before
           each token expires, and every answer extends its 8-hour session. A
           token captured at mount is the stale one, and a handler that answers
           only the first request dies at the first expiry. */
        const token = getActivePortalToken();
        if (token === null || token.length === 0) {
          // Stay silent. QuixLab retries on its own backoff.
          setWaitingForToken(true);
          return;
        }
        setWaitingForToken(false);
        // `origin`, never "*": a "*" target hands the token to whatever page
        // the frame navigated to.
        frameRef.current?.contentWindow?.postMessage({ type: AUTH_TOKEN, token }, origin);
        return;
      }

      if (data.type === REQUEST_TM_IMPORT) {
        // No run to import: the page frames QuixLab on the workspace, and
        // QuixLab then opens whatever it opens on its own.
        if (runId.length === 0) return;
        /* An empty pick means the whole run, and that is the message this
           frame always sent. Only a real pick adds `signals`, so a person who
           picks nothing gets exactly today's behavior.

           An over-long list is dropped, never truncated: QuixLab answers 400
           above the cap, and a silently shortened list would open the wrong
           signals. The note below says the frame opened the whole run. */
        const pick = signalsRef.current;
        const picked = pick.length > 0 && pick.length <= MAX_QUIXLAB_SIGNALS ? [...pick] : null;
        frameRef.current?.contentWindow?.postMessage(
          picked === null ? { type: TM_IMPORT, runId } : { type: TM_IMPORT, runId, signals: picked },
          origin,
        );
      }
    }

    window.addEventListener("message", onMessage);
    /* The effect sets the address, and it sets it last. The element renders
       with no `src`, so the frame starts loading only after the listener is
       mounted. A listener mounted after the load loses the first
       REQUEST_AUTH_TOKEN, and that first message is the one that gives the
       frame its session. */
    if (frameRef.current !== null) frameRef.current.src = embedUrl;
    return () => window.removeEventListener("message", onMessage);
  }, [origin, embedUrl, runId]);

  return (
    /* Filling changes THIS element's classes, and nothing else. The iframe
       keeps its place in the tree and its `key`, so it never remounts and the
       QuixLab session survives a resize. */
    <div className={cn("flex flex-1 flex-col", fill ? "min-h-0" : "min-h-[600px]")}>
      {signals.length > MAX_QUIXLAB_SIGNALS && (
        <p role="alert" className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          You picked {signals.length} signals, and QuixLab accepts at most{" "}
          {MAX_QUIXLAB_SIGNALS}. This frame opens the whole run instead. Clear
          some picks on the Signals tab to send a list.
        </p>
      )}
      {waitingForToken && (
        <p role="status" className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          QuixLab asked for a sign-in token and this browser holds none yet. QuixLab
          asks you to sign in, and the run opens once it has a session.
        </p>
      )}
      <iframe
        ref={frameRef}
        // No `src` here, and no `sandbox` attribute. The effect above sets the
        // address. QuixLab needs same-origin storage for its session cookie,
        // and a sandbox without `allow-same-origin` kills it.
        title={title}
        className={cn("w-full flex-1 border-0", fill ? "min-h-0" : "min-h-[600px]")}
      />
    </div>
  );
}
