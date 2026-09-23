"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NewTabMark } from "@/components/shared/new-tab-mark";
import { Panel, PanelHead } from "@/components/shared/panel";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  closeNotebook,
  createNotebook,
  deleteNotebook,
  getNotebookLab,
  listNotebooks,
  openNotebook,
  running,
  stopNotebook,
  type Notebook,
  type RunQuixLab,
} from "@/lib/api/run-quixlab";
import { keys } from "@/lib/hooks/keys";
import { getActivePortalToken } from "@/lib/portal/token-store";
import {
  currentTheme,
  EMBED_QUERY,
  KIND_DEPLOYMENT,
  MAX_QUIXLAB_SIGNALS,
  withTheme,
  type QuixLabInstance,
} from "@/lib/quixlab";
import { waitForLab } from "@/lib/quixlab-ready";
import { GIVE_UP_MS, POLL_MS } from "@/lib/run-quixlab";
import { cn } from "@/lib/utils";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";

/**
 * The run's QuixLab notebooks: make one, open a saved one, embed it, save and close it.
 *
 * **Why notebooks, and not a picker of QuixLabs.** The panel used to list every
 * QuixLab in the workspace and ask a person to choose. Everybody then landed on
 * the same canvas, and the run a notebook addressed lived in a per-viewer session
 * rather than in the notebook. Now a run holds its own notebooks — each a file in
 * a blob folder of its own — and opening one clones the workspace's QuixLab into
 * a deployment of this viewer's own on that folder. What is listed is the run's
 * work, not the workspace's containers. `api/quixlab_provision.py` carries the
 * design.
 *
 * **Why the frame, and not only the tab.** A tab has no parent, so nothing can
 * post it the signal pick from the Signals tab. The frame is the only path
 * that opens a narrowed run on screen.
 *
 * **Why it creates on a click and never on mount.** A lab is a container. A
 * person who opens a run to read its files must not be billed for one, so the
 * panel lists the notebooks and starts nothing until a name is clicked. One
 * click does the rest: create or start, wait, embed. Save and Close records the
 * save and stops the lab; opening the notebook again is a start, not a build.
 */

/** The message names QuixLab sends up, and the ones this panel sends down. */
const REQUEST_AUTH_TOKEN = "REQUEST_AUTH_TOKEN";
const AUTH_TOKEN = "AUTH_TOKEN";
const REQUEST_TM_IMPORT = "REQUEST_TM_IMPORT";
const TM_IMPORT = "TM_IMPORT";
/** Posted down when this page switches theme (`quixlab/src/quixlab/server/embed.py`). */
const QUIXLAB_THEME = "QUIXLAB_THEME";
/** Posted up by the lab's app the moment its script runs. */
const QUIXLAB_READY = "QUIXLAB_READY";

/**
 * How long the frame waits to hear ANYTHING from the lab after a load.
 *
 * QuixLab speaks within a second of loading — `QUIXLAB_READY` from its script,
 * `REQUEST_AUTH_TOKEN` from its sign-in gate. The ingress error page a lab
 * still starting answers with says nothing, ever, and never refreshes itself;
 * a frame that heard nothing in this long is on that page and is reloaded.
 */
export const FRAME_PATIENCE_MS = 12_000;

/** How many silent loads are retried before the frame stops reloading itself. */
export const FRAME_RELOADS = 8;

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
  /* How many times the frame was reloaded for silence, and whether it gave up.
     Zero once the lab has spoken. */
  const [reloads, setReloads] = useState(0);
  const [stalled, setStalled] = useState(false);

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
    /* The silence watchdog. Any message from the lab's origin proves the frame
       holds QuixLab; until one arrives, each load gets FRAME_PATIENCE_MS and is
       then loaded again with a cache-busting counter. */
    let heard = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The theme at load time rides on the address; a later switch goes by message.
    const src = withTheme(embedUrl, currentTheme());

    function load() {
      const frame = frameRef.current;
      if (frame === null) return;
      frame.src = attempt === 0 ? src : `${src}&reload=${attempt}`;
      timer = setTimeout(onSilence, FRAME_PATIENCE_MS);
    }

    function onSilence() {
      timer = null;
      if (heard) return;
      if (attempt >= FRAME_RELOADS) {
        setStalled(true);
        return;
      }
      attempt += 1;
      setReloads(attempt);
      load();
    }

    function onMessage(event: MessageEvent) {
      // The origin check is first and it is the whole point. Any page can post
      // a well-shaped message; only the browser sets `event.origin`.
      if (event.origin !== origin) return;
      if (!heard) {
        heard = true;
        if (timer !== null) clearTimeout(timer);
        setReloads(0);
        setStalled(false);
      }
      const data = event.data as { type?: unknown } | null;
      if (typeof data !== "object" || data === null) return;

      /* A page of the lab has just loaded — its gate asking for a token, or its app saying
         READY — so hand it the theme now, whatever its address carried. The address alone
         proved fragile: a hop inside the lab can drop the query, and then the page paints
         in its own stored theme. */
      if (data.type === REQUEST_AUTH_TOKEN || data.type === QUIXLAB_READY) {
        frameRef.current?.contentWindow?.postMessage(
          { type: QUIXLAB_THEME, theme: currentTheme() },
          origin,
        );
      }

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
    load();
    return () => {
      window.removeEventListener("message", onMessage);
      if (timer !== null) clearTimeout(timer);
    };
  }, [origin, embedUrl, runId]);

  /* The theme follows this page. The provider toggles the `dark` class on
     <html>; the observer posts every change down, and QuixLab repaints in
     place — no reload, so the session and the canvas survive the switch. */
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return undefined;
    let last = currentTheme();
    const observer = new MutationObserver(() => {
      const theme = currentTheme();
      if (theme === last) return;
      last = theme;
      frameRef.current?.contentWindow?.postMessage({ type: QUIXLAB_THEME, theme }, origin);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [origin]);

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
      {reloads > 0 && !stalled && (
        <p role="status" className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          QuixLab has not answered yet — the frame is being reloaded ({reloads} of{" "}
          {FRAME_RELOADS}). A lab that has just started takes a moment to listen.
        </p>
      )}
      {stalled && (
        <p role="alert" className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          QuixLab did not answer after {FRAME_RELOADS} reloads. Check the deployment in
          the Portal, then Save and Close and open the notebook again.
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

/** What one control is doing, while it is doing it. */
interface Progress {
  /** The notebook being started, or null while a new one is being created. */
  notebookId: string | null;
  text: string;
}

/** The notebook on screen and the lab that serves it. */
interface Active {
  notebook: Notebook;
  lab: RunQuixLab;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * The panel: the run's notebooks, a Create control, and the frame once one is open.
 */
export function QuixLabPanel({
  runId,
  signals = WHOLE_RUN,
  createOnMount = false,
  openOnMount = null,
  onCreateHandled,
  flat = false,
}: {
  runId: string;
  /** The pick from the Signals tab. Empty means the whole run. */
  signals?: readonly string[];
  /** True when the page was opened with a request to create a notebook ("Open in → New QuixLab notebook"). */
  createOnMount?: boolean;
  /** A notebook id the page was opened with a request to open (the Workflows page's Open). */
  openOnMount?: string | null;
  /** Called once either request has been acted on, so a reload does not repeat it. */
  onCreateHandled?: () => void;
  /** True inside a tab: no border and no margin of its own. */
  flat?: boolean;
}) {
  const queryClient = useQueryClient();
  /* The list asks and never creates, so opening a run costs no deployment. The labs
     on it come with the answer when this browser holds a Portal token. */
  const notebooks = useQuery({
    queryKey: keys.runs.notebooks(runId),
    queryFn: () => listNotebooks(runId),
  });
  const [active, setActive] = useState<Active | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [saving, setSaving] = useState(false);
  /** The notebook whose Delete was clicked once; a second click removes it. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* Portal frames the Test Manager, and the Test Manager frames QuixLab, so a
     notebook in a panel-sized box is unusable. An open notebook therefore always
     takes the whole content area, the rectangle the Explore tab claims, and the
     way out is Save and Close. */
  const expanded = active !== null;

  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: keys.runs.notebooks(runId) }),
    [queryClient, runId],
  );

  /* ONE control does the whole thing: make the notebook (or start a saved one's lab),
     wait for the container, then embed it. The control itself reports the progress.
     A deployment answers `Building` or `Starting` before anything serves on its
     address, so embedding at once would frame a 502 that never refreshes itself. */
  const start = useCallback(
    (notebookId: string | null) => {
      setError(null);
      setProgress({ notebookId, text: notebookId === null ? "Creating…" : "Starting…" });
      void (async () => {
        try {
          const notebook =
            notebookId === null ? await createNotebook(runId) : await openNotebook(runId, notebookId);
          refresh();
          let lab = notebook.lab ?? (await getNotebookLab(runId, notebook.notebook_id));
          const giveUpAt = Date.now() + GIVE_UP_MS;
          while (!running(lab) && Date.now() < giveUpAt) {
            setProgress({ notebookId, text: `Starting… (${lab.status.trim() || "queued"})` });
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            lab = await getNotebookLab(runId, notebook.notebook_id);
          }
          if (running(lab)) {
            // Running is the pod; the server inside listens a little later.
            // A lab that never answers the probe is framed anyway after a few seconds: the
            // frame reloads itself until QuixLab speaks (`FRAME_PATIENCE_MS`).
            setProgress({ notebookId, text: "Starting… (waiting for QuixLab to answer)" });
            await waitForLab(lab.url);
            setActive({ notebook, lab });
          } else {
            setError("The QuixLab is still starting. Try again in a moment.");
          }
        } catch (caught: unknown) {
          setError(caught instanceof ApiError ? caught.message : "QuixLab could not be started");
        } finally {
          setProgress(null);
          refresh();
        }
      })();
    },
    [runId, refresh],
  );

  /* Save and Close: the save is recorded and the lab is stopped. The frame goes only
     once the server says both happened, because a frame that closed on a save that
     then failed would have thrown away the person's last view of their work. */
  const saveAndClose = useCallback(() => {
    if (active === null) return;
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        await closeNotebook(runId, active.notebook.notebook_id);
        setActive(null);
        refresh();
        toast.success(`${active.notebook.name} saved; QuixLab stopped.`);
      } catch (caught: unknown) {
        setError(caught instanceof ApiError ? caught.message : "The notebook could not be saved");
      } finally {
        setSaving(false);
      }
    })();
  }, [runId, active, refresh]);

  /* "Open in → New QuixLab notebook" lands here with the request in the URL; it is acted
     on once, then handed back so a reload does not make a second notebook. */
  const createRequested = useRef(false);
  useEffect(() => {
    if (!createOnMount || createRequested.current) return;
    createRequested.current = true;
    onCreateHandled?.();
    start(null);
  }, [createOnMount, onCreateHandled, start]);

  /* The Workflows page's Open lands here the same way, with the notebook's id. */
  const openRequested = useRef<string | null>(null);
  useEffect(() => {
    if (openOnMount === null || openRequested.current === openOnMount) return;
    openRequested.current = openOnMount;
    onCreateHandled?.();
    start(openOnMount);
  }, [openOnMount, onCreateHandled, start]);

  /* Stop halts this viewer's lab on a notebook without opening it: a lab left running
     costs a container, and QuixLab has already pushed every edit to the notebook's folder. */
  const stop = useCallback(
    (notebook: Notebook) => {
      setStopping(notebook.notebook_id);
      setError(null);
      void (async () => {
        try {
          await stopNotebook(runId, notebook.notebook_id);
          refresh();
          toast.success(`QuixLab on ${notebook.name} stopped.`);
        } catch (caught: unknown) {
          setError(caught instanceof ApiError ? caught.message : "The QuixLab could not be stopped");
        } finally {
          setStopping(null);
        }
      })();
    },
    [runId, refresh],
  );

  /* Delete asks twice on the same button rather than in a dialog: the first click arms it,
     the second removes the notebook and this viewer's lab on it. Any other click disarms. */
  const remove = useCallback(
    (notebook: Notebook) => {
      if (confirming !== notebook.notebook_id) {
        setConfirming(notebook.notebook_id);
        return;
      }
      setConfirming(null);
      setRemoving(notebook.notebook_id);
      setError(null);
      void (async () => {
        try {
          await deleteNotebook(runId, notebook.notebook_id);
          refresh();
          toast.success(`${notebook.name} deleted.`);
        } catch (caught: unknown) {
          setError(caught instanceof ApiError ? caught.message : "The notebook could not be deleted");
        } finally {
          setRemoving(null);
        }
      })();
    },
    [runId, confirming, refresh],
  );

  const instance = active !== null && active.lab.url.length > 0 ? asInstance(active.lab) : null;
  const rows = notebooks.data ?? [];
  const busy = progress !== null;

  return (
    <Panel
      className={cn(
        flat ? "rounded-none border-0" : "mt-4",
        /* Expanded covers the content area, below the topbar and between the
           sidebar and the assistant dock — the same rectangle the Explore tab
           claims, from the same constant. The height is the viewport's, so a
           tall screen gains from it. */
        expanded && cn(SHELL_BREAKOUT_CLASS, "mt-0 rounded-none border"),
      )}
    >
      <PanelHead
        title="Notebooks"
        action={
          <div className="flex items-center gap-2">
            {active !== null && (
              <span className="text-[0.78rem] text-ink-3">{active.notebook.name}</span>
            )}
            {active !== null && (
              <Button
                variant="outline"
                size="sm"
                className="font-semibold"
                /* No `await` in front of the open: the address is already
                   resolved, and a `window.open` a fetch answer triggers is
                   blocked. */
                onClick={() => window.open(active.lab.url, "_blank", "noopener,noreferrer")}
              >
                <span>Open in a tab</span>
                <NewTabMark iconClassName="size-3 opacity-80" />
              </Button>
            )}
            {active !== null && (
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
            {active === null && (
              <Button
                size="sm"
                className="font-semibold"
                disabled={busy}
                aria-busy={busy}
                onClick={() => start(null)}
              >
                {progress !== null && progress.notebookId === null
                  ? progress.text
                  : "Create QuixLab notebook"}
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
      {active === null && notebooks.isSuccess && rows.length === 0 && error === null && (
        <p className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          No notebooks yet. Create one: it loads this run&rsquo;s data and opens in a QuixLab
          of your own. Save and Close keeps it under the run and stops the QuixLab; open it
          again any time, and make as many as the work needs.
        </p>
      )}
      {active === null && rows.length > 0 && (
        <ul className="divide-y divide-line-2" aria-label="Notebooks">
          {rows.map((notebook) => {
            const mine = progress !== null && progress.notebookId === notebook.notebook_id;
            const lab = notebook.lab;
            const up = lab !== null && !["stopped", "stopping", ""].includes(lab.status.trim().toLowerCase());
            const state =
              lab === null
                ? notebook.saved_at === null
                  ? "never saved"
                  : `saved ${when(notebook.saved_at)}`
                : running(lab)
                  ? "QuixLab running"
                  : `QuixLab ${lab.status.trim().toLowerCase() || "stopped"}${
                      notebook.saved_at === null ? "" : ` · saved ${when(notebook.saved_at)}`
                    }`;
            return (
              <li
                key={notebook.notebook_id}
                className="flex items-center gap-3 px-4 py-2 text-[0.82rem]"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-ink">{notebook.name}</div>
                  <div className="truncate text-[0.74rem] text-ink-3">
                    {notebook.created_by} · {when(notebook.created_at)} · {state}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="font-semibold"
                  disabled={busy}
                  aria-busy={mine}
                  aria-label={`Open ${notebook.name}`}
                  onClick={() => {
                    setConfirming(null);
                    start(notebook.notebook_id);
                  }}
                >
                  {mine ? progress.text : "Open"}
                </Button>
                {up && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="font-semibold"
                    disabled={busy || stopping !== null}
                    aria-busy={stopping === notebook.notebook_id}
                    aria-label={`Stop ${notebook.name}`}
                    title="Stop your QuixLab on this notebook; the notebook keeps every edit"
                    onClick={() => {
                      setConfirming(null);
                      stop(notebook);
                    }}
                  >
                    {stopping === notebook.notebook_id ? "Stopping…" : "Stop"}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "font-semibold",
                    confirming === notebook.notebook_id &&
                      "text-red hover:border-red-border hover:bg-red-bg hover:text-red",
                  )}
                  disabled={busy || removing !== null}
                  aria-busy={removing === notebook.notebook_id}
                  aria-label={
                    confirming === notebook.notebook_id
                      ? `Confirm deleting ${notebook.name}`
                      : `Delete ${notebook.name}`
                  }
                  title="Removes the notebook and your QuixLab on it; its files stay in storage"
                  onClick={() => remove(notebook)}
                  onBlur={() => {
                    if (confirming === notebook.notebook_id) setConfirming(null);
                  }}
                >
                  {removing === notebook.notebook_id
                    ? "Deleting…"
                    : confirming === notebook.notebook_id
                      ? "Sure?"
                      : "Delete"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {signals.length > 0 && (
        <p className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          {signals.length} {signals.length === 1 ? "signal is" : "signals are"} picked
          on the Signals tab, and the frame opens {signals.length === 1 ? "it" : "them"}.
          “Open in a tab” opens the whole run: a list of signal names does not
          belong in a URL, where it gets logged, pasted and cut short.
        </p>
      )}
      {instance !== null && (
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
