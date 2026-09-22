"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NewTabMark } from "@/components/shared/new-tab-mark";
import { Panel, PanelHead } from "@/components/shared/panel";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  closeRunQuixLab,
  createRunQuixLab,
  getRunQuixLab,
  running,
  type RunQuixLab,
} from "@/lib/api/run-quixlab";
import { keys } from "@/lib/hooks/keys";
import { getActivePortalToken } from "@/lib/portal/token-store";
import {
  EMBED_QUERY,
  KIND_DEPLOYMENT,
  MAX_QUIXLAB_SIGNALS,
  type QuixLabInstance,
} from "@/lib/quixlab";
import { GIVE_UP_MS, POLL_MS } from "@/lib/run-quixlab";
import { cn } from "@/lib/utils";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";

/**
 * This viewer's own QuixLab for this run: make it, open it in a tab, embed it.
 *
 * **Why there is no longer a picker.** The panel used to list every QuixLab in
 * the workspace and ask a person to choose. Everybody then landed on the same
 * canvas, and the run a notebook addressed lived in a per-viewer session
 * rather than in the notebook. Now the API clones the workspace's QuixLab into
 * a deployment of this viewer's own, opened on a notebook written into this
 * run's own folder — so there is exactly one lab this panel can mean, and
 * nothing to choose between. `api/quixlab_provision.py` carries the design.
 *
 * **Why the frame, and not only the tab.** A tab has no parent, so nothing can
 * post it the signal pick from the Signals tab. The frame is the only path
 * that opens a narrowed run on screen.
 *
 * **Why it creates on a click and never on mount.** A lab is a container. A
 * person who opens a run to read its files must not be billed for one, so the
 * panel asks whether they already have a notebook and otherwise offers to make
 * one. One click does the rest: create or start, wait, embed. Save and Close
 * files the notebook under the run and stops the lab; opening it again is a
 * start, not a build.
 */

/** The two message names QuixLab sends up, and the two this panel sends down. */
const REQUEST_AUTH_TOKEN = "REQUEST_AUTH_TOKEN";
const AUTH_TOKEN = "AUTH_TOKEN";
const REQUEST_TM_IMPORT = "REQUEST_TM_IMPORT";
const TM_IMPORT = "TM_IMPORT";

/**
 * One person's lab in the shape the frame below already takes.
 *
 * `QuixLabFrame` was written against a picked instance and needs no change:
 * it wants an origin to post to, an address to load and a name for the title.
 * A lab is always a deployment — it is one, cloned from the workspace's —
 * so the kind is stated rather than guessed.
 */
function asInstance(lab: RunQuixLab): QuixLabInstance {
  return {
    id: lab.id,
    name: lab.name,
    kind: KIND_DEPLOYMENT,
    status: lab.status,
    url: lab.url,
    embed_url: `${lab.url}?${EMBED_QUERY}`,
    origin: new URL(lab.url).origin,
  };
}

/** The pick a caller passes nothing for. One constant, so it holds still. */
const WHOLE_RUN: readonly string[] = [];

/**
 * The QuixLab frame, and the handshake that gives it a session and a run.
 *
 * The whole message dance lives in one effect, so the listener and the `src`
 * start in one order and stop together.
 */
export function QuixLabFrame({
  instance,
  runId,
  signals = WHOLE_RUN,
  expanded = false,
}: {
  instance: QuixLabInstance;
  runId: string;
  /** The signal names a person picked, or an empty list for the whole run. */
  signals?: readonly string[];
  /** True while the frame fills the content area. It changes classes only. */
  expanded?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  /* True while QuixLab has asked for a token and this browser holds none. It is
     not an error: QuixLab keeps asking, and it shows its own sign-in form. The
     note below says so, instead of leaving a person with a blank frame. */
  const [waitingForToken, setWaitingForToken] = useState(false);

  const { origin, embed_url: embedUrl } = instance;

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
    /* Expanding changes THIS element's classes, and nothing else. The iframe
       keeps its place in the tree and its `key`, so it never remounts and the
       QuixLab session survives a resize. */
    <div className={cn("flex flex-1 flex-col", expanded ? "min-h-0" : "min-h-[600px]")}>
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
        title={`QuixLab - ${instance.name}`}
        className={cn("w-full flex-1 border-0", expanded ? "min-h-0" : "min-h-[600px]")}
      />
    </div>
  );
}

/**
 * The panel: one picker and two actions, plus the frame once a person opens it.
 *
 * The panel renders nothing at all when nothing resolves. A screen never
 * promises a destination we cannot reach.
 */
export function QuixLabPanel({
  runId,
  signals = WHOLE_RUN,
}: {
  runId: string;
  /** The pick from the Signals tab. Empty means the whole run. */
  signals?: readonly string[];
}) {
  const [lab, setLab] = useState<RunQuixLab | null>(null);
  /** What the primary control is doing, while it is doing it. Null when idle. */
  const [progress, setProgress] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [embedded, setEmbedded] = useState(false);
  /* Portal frames the Test Manager, and the Test Manager frames QuixLab, so
     QuixLab renders in a small box. Expanded lifts the panel over the content
     area, the same recipe the Explore tab uses. That state belongs to Explore
     and stays there — this panel never renders on the Explore tab. */
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  /* Does this viewer already have a notebook for this run? A 404 is the ordinary
     "not yet" and never an error. This asks and never creates, so opening a run
     costs no deployment. */
  useEffect(() => {
    let live = true;
    getRunQuixLab(runId).then(
      (found) => {
        if (live) setLab(found);
      },
      () => {
        if (live) setLab(null);
      },
    );
    return () => {
      live = false;
    };
  }, [runId]);

  // Escape leaves the expanded frame, the same key the Explore focus layout
  // answers. The frame keeps the keyboard while QuixLab has it, so the listener
  // sits on the window and not on the panel.
  useEffect(() => {
    if (!expanded) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  /* ONE control does the whole thing: create the lab (or start a saved one), wait
     for the container, then embed it. The button itself reports the progress. A
     deployment answers `Building` or `Starting` before anything serves on its
     address, so embedding at once would frame a 502 that never refreshes itself. */
  const open = useCallback(() => {
    setError(null);
    setProgress(lab === null ? "Creating…" : "Starting…");
    void (async () => {
      try {
        let made = await createRunQuixLab(runId);
        setLab(made);
        const giveUpAt = Date.now() + GIVE_UP_MS;
        while (!running(made) && Date.now() < giveUpAt) {
          setProgress(`Starting… (${made.status.trim() || "queued"})`);
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          made = await getRunQuixLab(runId);
          setLab(made);
        }
        if (running(made)) {
          setEmbedded(true);
          setExpanded(false);
        } else {
          setError("The QuixLab is still starting. Try again in a moment.");
        }
      } catch (caught: unknown) {
        setError(
          caught instanceof ApiError ? caught.message : "QuixLab could not be started",
        );
      } finally {
        setProgress(null);
      }
    })();
  }, [runId, lab]);

  /* Save and Close: the notebook is filed under this run as a processed result and
     the lab is stopped. The frame goes only once the server says both happened,
     because a frame that closed on a save that then failed would have thrown
     away the person's last view of their work. */
  const saveAndClose = useCallback(() => {
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        const closed = await closeRunQuixLab(runId);
        setLab(closed);
        setEmbedded(false);
        setExpanded(false);
        void queryClient.invalidateQueries({ queryKey: keys.results.all });
        void queryClient.invalidateQueries({ queryKey: keys.runs.detail(runId) });
        toast.success("Notebook saved under this run's processed results; QuixLab stopped.");
      } catch (caught: unknown) {
        setError(caught instanceof ApiError ? caught.message : "The notebook could not be saved");
      } finally {
        setSaving(false);
      }
    })();
  }, [runId, queryClient]);

  const ready = lab !== null && running(lab) && lab.url.length > 0;
  const instance = ready ? asInstance(lab) : null;
  const primaryLabel = progress ?? (lab === null ? "Create QuixLab notebook" : "Open QuixLab notebook");

  return (
    <Panel
      className={cn(
        "mt-4",
        /* Expanded covers the content area, below the topbar and between the
           sidebar and the assistant dock — the same rectangle the Explore tab
           claims, from the same constant. The height is the viewport's, so a
           tall screen gains from it. */
        expanded && cn(SHELL_BREAKOUT_CLASS, "mt-0 rounded-none"),
      )}
    >
      <PanelHead
        title="QuixLab notebooks"
        action={
          <div className="flex items-center gap-2">
            {lab !== null && (
              <span className="text-[0.78rem] text-ink-3">
                {lab.name}
                {running(lab) ? "" : ` - ${lab.status.trim() || "stopped"}`}
              </span>
            )}
            {ready && (
              <Button
                variant="outline"
                size="sm"
                className="font-semibold"
                /* No `await` in front of the open: the address is already
                   resolved, and a `window.open` a fetch answer triggers is
                   blocked. */
                onClick={() => window.open(lab.url, "_blank", "noopener,noreferrer")}
              >
                <span>Open in a tab</span>
                <NewTabMark iconClassName="size-3 opacity-80" />
              </Button>
            )}
            {!embedded && (
              <Button
                size="sm"
                className="font-semibold"
                disabled={progress !== null}
                aria-busy={progress !== null}
                onClick={open}
              >
                {primaryLabel}
              </Button>
            )}
            {embedded && instance !== null && (
              <Button
                variant="outline"
                size="sm"
                className="font-semibold"
                aria-pressed={expanded}
                aria-label={expanded ? "Collapse the QuixLab frame" : "Expand the QuixLab frame"}
                onClick={() => setExpanded((on) => !on)}
              >
                {expanded ? "Collapse" : "Expand"}
              </Button>
            )}
            {embedded && (
              <Button
                size="sm"
                className="font-semibold"
                disabled={saving}
                aria-busy={saving}
                onClick={saveAndClose}
              >
                {saving ? "Saving…" : "Save and Close"}
              </Button>
            )}
          </div>
        }
      />
      {error !== null && (
        <p role="alert" className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          {error}
        </p>
      )}
      {lab === null && error === null && (
        <p className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          A notebook that loads this run&rsquo;s data, opened in a QuixLab of your own.
          Save and Close files it under the run&rsquo;s processed results and stops the
          QuixLab; open it again any time.
        </p>
      )}
      {lab !== null && !embedded && lab.saved_result_id && error === null && (
        <p className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          Saved under this run&rsquo;s processed results. The QuixLab is stopped; opening
          the notebook starts it again where you left it.
        </p>
      )}
      {signals.length > 0 && (
        <p className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          {signals.length} {signals.length === 1 ? "signal is" : "signals are"} picked
          on the Signals tab, and the frame opens {signals.length === 1 ? "it" : "them"}.
          “Open in a tab” opens the whole run: a list of signal names does not
          belong in a URL, where it gets logged, pasted and cut short.
        </p>
      )}
      {embedded && instance !== null && (
        // The key resets the handshake with the lab: a new deployment is a new
        // frame, never the old page with a new address.
        <QuixLabFrame
          key={instance.id}
          instance={instance}
          runId={runId}
          signals={signals}
          expanded={expanded}
        />
      )}
    </Panel>
  );
}
