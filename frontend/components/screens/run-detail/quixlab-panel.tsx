"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NewTabMark } from "@/components/shared/new-tab-mark";
import { Panel, PanelHead } from "@/components/shared/panel";
import { SingleSelect, type SingleSelectOption } from "@/components/shared/single-select";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { listQuixLabs } from "@/lib/api/integrations";
import { getActivePortalToken } from "@/lib/portal/token-store";
import {
  configuredQuixLab,
  KIND_DEPLOYMENT,
  MAX_QUIXLAB_SIGNALS,
  openQuixLab,
  type QuixLabInstance,
} from "@/lib/quixlab";
import { cn } from "@/lib/utils";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";

/**
 * Pick a QuixLab, then open it in a tab or embed it here.
 *
 * **Why a picker at all.** One `TM_QUIXLAB_URL` names one QuixLab, and a
 * workspace holds many: the shared deployments and the personal dev sessions.
 * `GET /api/v1/integrations/quixlabs` lists both, with the viewer's Portal
 * token, so the answer names the machines this viewer may open.
 *
 * **Why the frame, and not only the tab.** A tab has no parent, so nothing can
 * post it a run id, and the notebook then guesses the newest run. The frame is
 * the only path that opens the run on screen.
 */

/** The two message names QuixLab sends up, and the two this panel sends down. */
const REQUEST_AUTH_TOKEN = "REQUEST_AUTH_TOKEN";
const AUTH_TOKEN = "AUTH_TOKEN";
const REQUEST_TM_IMPORT = "REQUEST_TM_IMPORT";
const TM_IMPORT = "TM_IMPORT";

/**
 * True when a person may open this instance.
 *
 * The Portal's own word decides it, compared in lower case. An **empty** status
 * is the configured fallback, which the Portal never described: unknown stays
 * pickable, because refusing it would hide the one QuixLab the local stack and
 * the demo path have.
 */
function selectable(item: QuixLabInstance): boolean {
  const status = item.status.trim().toLowerCase();
  return status.length === 0 || status === "running";
}

/** The word a person reads beside the name. A dev session is not a deployment. */
function kindLabel(item: QuixLabInstance): string {
  return item.kind === KIND_DEPLOYMENT ? "Deployment" : "Dev session";
}

function optionLabel(item: QuixLabInstance): string {
  const status = item.status.trim();
  const state = status.length === 0 ? "" : ` - ${status}`;
  return `${item.name} (${kindLabel(item)})${state}`;
}

/** One picker option. The label keeps the name, the kind and the state. */
function toOption(item: QuixLabInstance): SingleSelectOption {
  return { value: item.id, label: optionLabel(item), disabled: !selectable(item) };
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
  const [items, setItems] = useState<QuixLabInstance[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [outage, setOutage] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  /* Portal frames the Test Manager, and the Test Manager frames QuixLab, so
     QuixLab renders in a small box. Expanded lifts the panel over the content
     area, the same recipe the Explore tab uses. That state belongs to Explore
     and stays there — this panel never renders on the Explore tab. */
  const [expanded, setExpanded] = useState(false);

  /* The list is fetched once, on mount, and never on the click. A browser
     blocks a `window.open` that a fetch answer triggers, so the URL the tab
     control opens is already resolved when a person clicks it. */
  useEffect(() => {
    let live = true;
    const fallback = configuredQuixLab();

    function settle(found: QuixLabInstance[], platformDown: boolean) {
      if (!live) return;
      // An empty list is an ordinary answer, so the configured value stands in.
      const rows = found.length > 0 ? found : fallback === null ? [] : [fallback];
      setItems(rows);
      setOutage(platformDown);
      // Never default to a dev session: it belongs to one person and it stops.
      setPickedId(
        rows.find((row) => row.kind === KIND_DEPLOYMENT && selectable(row))?.id ?? null,
      );
    }

    listQuixLabs().then(
      (found) => settle(found, false),
      (error: unknown) => {
        // 503 platform_unavailable is an outage, and it must not read as
        // "there are none". Every other failure is the ordinary empty answer.
        const down =
          error instanceof ApiError &&
          error.status === 503 &&
          error.code === "platform_unavailable";
        settle([], down);
      },
    );
    return () => {
      live = false;
    };
  }, []);

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

  const picked = items.find((item) => item.id === pickedId) ?? null;

  const onPick = useCallback((id: string) => {
    setPickedId(id.length > 0 ? id : null);
    // A new pick is a new frame, a new origin and a new handshake.
    setEmbedded(false);
  }, []);

  if (items.length === 0) return null;

  const deployments = items.filter((item) => item.kind === KIND_DEPLOYMENT);
  const sessions = items.filter((item) => item.kind !== KIND_DEPLOYMENT);

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
        title="Analyze in QuixLab"
        action={
          <div className="flex items-center gap-2">
            {/* Two groups, because a dev session is personal and it stops.
                A person must see which kind they are about to open. A stopped
                instance stays visible and stays unpickable — hiding it would
                read as "it was never there". */}
            <SingleSelect
              label="QuixLab"
              value={picked?.id ?? null}
              onChange={onPick}
              placeholder="Choose a QuixLab"
              groups={[
                { label: "Deployments", options: deployments.map(toOption) },
                { label: "Dev sessions", options: sessions.map(toOption) },
              ]}
              triggerClassName="max-w-[19rem]"
            />
            <Button
              variant="outline"
              size="sm"
              className="font-semibold"
              disabled={picked === null}
              /* No `await` in front of the open: the list is already resolved.
                 The Portal's embedded view first, so a tab lands inside the
                 Portal and not on the raw deployment host. The Portal copies
                 the deep link and the run id straight into the frame, so the
                 run scoping survives the extra hop. A dev session has no
                 deployment id and therefore no Portal page, so it keeps the
                 direct URL. */
              onClick={() =>
                openQuixLab(
                  (picked?.portal_embedded_url ?? "").length > 0
                    ? picked?.portal_embedded_url
                    : picked?.url,
                  runId,
                )
              }
            >
              <span>Open in a tab</span>
              <NewTabMark iconClassName="size-3 opacity-80" />
            </Button>
            <Button
              size="sm"
              className="font-semibold"
              disabled={picked === null}
              onClick={() => {
                // Closing the frame leaves the expanded layout with it. An
                // expanded empty panel would cover the run for no reason.
                setEmbedded((on) => !on);
                setExpanded(false);
              }}
            >
              {embedded ? "Close the frame" : "Embed here"}
            </Button>
            {/* The control appears with the frame, because there is nothing to
                expand without it. It never touches the frame's place in the
                tree, so the QuixLab session survives the toggle. */}
            {embedded && picked !== null && (
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
          </div>
        }
      />
      {outage && (
        <p role="alert" className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          The Quix platform did not answer, so this list may be incomplete. The
          configured QuixLab still works.
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
      {embedded && picked !== null && (
        // The key resets the handshake with the pick: a new instance is a new
        // frame, never the old page with a new address.
        <QuixLabFrame key={picked.id} instance={picked} runId={runId} signals={signals} expanded={expanded} />
      )}
    </Panel>
  );
}
