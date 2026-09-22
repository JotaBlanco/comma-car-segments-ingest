"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NewTabMark } from "@/components/shared/new-tab-mark";
import { WorkbookMenu } from "@/components/shared/workbook-menu";
import { Panel, PanelHead } from "@/components/shared/panel";
import { Button } from "@/components/ui/button";
import {
  ftsConfigured,
  ftsFrameUrl,
  ftsOrigin,
  ftsTabUrl,
  openFts,
  type FtsEntry,
} from "@/lib/fts";
import { getActivePortalToken } from "@/lib/portal/token-store";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";
import { cn } from "@/lib/utils";

/**
 * Open THIS run in the Flight Test Station, in a tab or framed here. No picker
 * unlike QuixLab: one `TM_FTS_URL`, and both controls open the same URL entry.
 */

/** The two message names the station sends up, and the one this panel sends down. */
const REQUEST_AUTH_TOKEN = "REQUEST_AUTH_TOKEN";
const AUTH_TOKEN = "AUTH_TOKEN";


/** The pick a caller passes nothing for. One constant, so it holds still. */
const WHOLE_RUN: readonly string[] = [];

/** One comparable string for a pick. Sorted: a reorder is not a new pick. */
function pickKey(signals: readonly string[]): string {
  return [...signals].sort().join("\n");
}

/**
 * The station frame, and the token relay that gives it a session. Framed two
 * deep the Portal's SDK never reaches it, so it asks its parent instead.
 */
export function FtsFrame({
  entry,
  origin,
  expanded = false,
}: {
  entry: FtsEntry;
  origin: string;
  /** True while the frame fills the content area. It changes classes only. */
  expanded?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [waitingForToken, setWaitingForToken] = useState(false);

  const src = entry.url;

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only the browser sets `event.origin`; a shape proves nothing.
      if (event.origin !== origin) return;
      const data = event.data as { type?: unknown } | null;
      if (typeof data !== "object" || data === null) return;
      if (data.type !== REQUEST_AUTH_TOKEN) return;

      // Read the token now: one captured at mount is the stale one.
      const token = getActivePortalToken();
      if (token === null || token.length === 0) {
        setWaitingForToken(true);
        return;
      }
      setWaitingForToken(false);
      // `origin`, never "*": "*" follows the frame wherever it navigates.
      frameRef.current?.contentWindow?.postMessage(
        { type: AUTH_TOKEN, token },
        origin,
      );
    }

    window.addEventListener("message", onMessage);
    // Address last: a late listener loses the first token request.
    if (frameRef.current !== null) frameRef.current.src = src;
    return () => window.removeEventListener("message", onMessage);
  }, [origin, src]);

  return (
    <div
      className={cn(
        "flex flex-1 flex-col",
        expanded ? "min-h-0" : "min-h-[600px]",
      )}
    >
      {entry.signalsDropped && (
        <p
          role="alert"
          className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3"
        >
          Your pick is too long for a link, so this frame opens the whole run.
          Clear some picks on the Signals tab and reopen to send a list.
        </p>
      )}
      {waitingForToken && (
        <p
          role="status"
          className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3"
        >
          The station asked for a sign-in token and this browser holds none yet.
          It keeps asking, and the run opens once a token arrives.
        </p>
      )}
      <iframe
        ref={frameRef}
        // The effect sets `src`; no sandbox, the station needs its storage.
        title="Flight Test Station"
        className={cn(
          "w-full flex-1 border-0",
          expanded ? "min-h-0" : "min-h-[600px]",
        )}
      />
    </div>
  );
}

/** The panel: two actions, plus the frame. Nothing when no station resolves. */
export function FtsPanel({
  runId,
  signals = WHOLE_RUN,
}: {
  runId: string;
  /** The pick from the Signals tab. Empty means the whole run. */
  signals?: readonly string[];
}) {
  // What the frame opened with; a new pick reopens only on request.
  const [opened, setOpened] = useState<{
    entry: FtsEntry;
    pick: string;
    // Counts the opens, so a reopen always remounts, even to the same address.
    seq: number;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const origin = ftsOrigin();

  // Escape leaves the expanded frame, as the Explore layout does.
  useEffect(() => {
    if (!expanded) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const openFrame = useCallback(() => {
    const entry = ftsFrameUrl(runId, signals, window.location.origin);
    if (entry === null) return;
    setOpened((was) => ({ entry, pick: pickKey(signals), seq: (was?.seq ?? 0) + 1 }));
  }, [runId, signals]);

  if (!ftsConfigured()) return null;

  // The frame hits the length cap first, so the frame decides for both.
  const framed = ftsFrameUrl(runId, signals, window.location.origin);
  const dropped = framed?.signalsDropped ?? false;
  const tab = ftsTabUrl(runId, dropped ? WHOLE_RUN : signals);
  const drifted = opened !== null && opened.pick !== pickKey(signals);

  return (
    <Panel
      className={cn(
        "mt-4",
        expanded && cn(SHELL_BREAKOUT_CLASS, "mt-0 rounded-none"),
      )}
    >
      <PanelHead
        title="Open in the Flight Test Station"
        action={
          <div className="flex items-center gap-2">
            {/* A saved dashboard, on this run and pick. */}
            <WorkbookMenu run={runId} signals={dropped ? WHOLE_RUN : signals} />
            <Button
              variant="outline"
              size="sm"
              className="font-semibold"
              onClick={() => openFts(tab)}
            >
              <span>Open in a tab</span>
              <NewTabMark iconClassName="size-3 opacity-80" />
            </Button>
            <Button
              size="sm"
              className="font-semibold"
              disabled={origin === null}
              onClick={() => {
                if (opened !== null) {
                  setOpened(null);
                  setExpanded(false);
                  return;
                }
                openFrame();
              }}
            >
              {opened !== null ? "Close the frame" : "Embed here"}
            </Button>
            {opened !== null && (
              <Button
                variant="outline"
                size="sm"
                className="font-semibold"
                aria-pressed={expanded}
                aria-label={
                  expanded
                    ? "Collapse the station frame"
                    : "Expand the station frame"
                }
                onClick={() => setExpanded((on) => !on)}
              >
                {expanded ? "Collapse" : "Expand"}
              </Button>
            )}
          </div>
        }
      />
      {origin === null && (
        <p
          role="alert"
          className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3"
        >
          This deployment resolved no station origin, so the frame stays closed.
          “Open in a tab” still works: a tab needs no token relay.
        </p>
      )}
      {signals.length > 0 && !dropped && (
        <p className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
          {signals.length} {signals.length === 1 ? "signal is" : "signals are"}{" "}
          picked on the Signals tab, and both controls open{" "}
          {signals.length === 1 ? "it" : "them"} on this run.
        </p>
      )}
      {drifted && (
        <div
          role="status"
          className="flex items-center gap-3 border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3"
        >
          <span>
            Your pick changed since this frame opened. Reopening reloads the
            station, so the zoom and the marked period in it are lost.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="font-semibold"
            onClick={openFrame}
          >
            Reopen with the current picks
          </Button>
        </div>
      )}
      {opened !== null && origin !== null && (
        // The key is the address: a reopen is a new frame.
        <FtsFrame
          key={`${opened.seq}:${opened.entry.url}`}
          entry={opened.entry}
          origin={origin}
          expanded={expanded}
        />
      )}
    </Panel>
  );
}
