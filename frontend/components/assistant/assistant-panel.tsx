"use client";

/**
 * The assistant column (AS-4/AS-5) — 384px beside the content, 0 when closed.
 * The app grid's third column is `auto`, so animating this aside's own width
 * shrinks the main content without overlaying it (the concept's grid
 * transition, done panel-side so AppShell stays a server component).
 *
 * Renders nothing until GET /assistant/status confirms the feature; ⌘J is
 * registered here (the ⌘K idiom from global-search.tsx) and gated the same
 * way. The transcript stays mounted while the panel is closed — `inert` keeps
 * its controls out of the tab order.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, MessageCircle, PanelLeft, PanelRight, PictureInPicture2, Send, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAssistantChat, useAssistantStatus } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useAssistantPanel } from "./assistant-provider";
import { AssistantTurn, UserTurn } from "./assistant-turns";

const SUGGESTIONS = [
  "What arrived today?",
  "Quarantined files this week",
  "Runs missing work orders",
] as const;

/* Resizable width. Persisted like the theme ("tm-theme" → localStorage), read
   back after mount so the server render always matches the first client
   render. The clamp keeps the panel usable (hit cards need ~320px) without
   letting it swallow the content column. */
const WIDTH_KEY = "tm-assistant-width";
const DEFAULT_WIDTH = 384;
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const KEY_STEP = 16;

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

/* Storage access is guarded: the server render and the component-test DOM
   have no localStorage, and a browser in a locked-down mode can throw on
   access. A missing store simply means the default width. */
function readStoredWidth(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampWidth(stored);
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_WIDTH;
}

function storeWidth(value: number): void {
  try {
    globalThis.localStorage?.setItem(WIDTH_KEY, String(value));
  } catch {
    /* a width that does not persist is still a width */
  }
}

/* Dock mode. "docked" is the grid column; "floating" is a draggable window
   over the app (the Quix AI pattern). Mode and window position persist like
   the width; the transcript survives a switch because the panel never
   unmounts — only its positioning changes. */
type DockMode = "docked" | "docked-left" | "floating";
const MODE_KEY = "tm-assistant-mode";
const POS_KEY = "tm-assistant-pos";
const HEIGHT_KEY = "tm-assistant-height";
const MIN_HEIGHT = 320;

/** Stored floating height, or null for the CSS default (min(680px, vh-96)). */
function readStoredHeight(): number | null {
  try {
    const stored = Number(globalThis.localStorage?.getItem(HEIGHT_KEY));
    if (Number.isFinite(stored) && stored >= MIN_HEIGHT) return Math.round(stored);
  } catch {
    /* default below */
  }
  return null;
}

function readStoredMode(): DockMode {
  try {
    const stored = globalThis.localStorage?.getItem(MODE_KEY);
    // "docked" is the legacy value for the right dock, kept for stored state.
    if (stored === "floating" || stored === "docked-left") return stored;
  } catch {
    /* default below */
  }
  return "docked";
}

function readStoredPos(): { x: number; y: number } | null {
  try {
    const raw = globalThis.localStorage?.getItem(POS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as { x?: unknown }).x === "number" &&
        typeof (parsed as { y?: unknown }).y === "number"
      ) {
        return parsed as { x: number; y: number };
      }
    }
  } catch {
    /* default below */
  }
  return null;
}

function clampPos(x: number, y: number, width: number): { x: number; y: number } {
  const maxX = Math.max(8, window.innerWidth - width - 8);
  const maxY = Math.max(60, window.innerHeight - 160);
  return { x: Math.min(maxX, Math.max(8, Math.round(x))), y: Math.min(maxY, Math.max(60, Math.round(y))) };
}

export function AssistantPanel() {
  const { open, setOpen, toggle } = useAssistantPanel();
  const { data: status } = useAssistantStatus();
  const enabled = status?.enabled === true;
  const { messages, send, streaming, error } = useAssistantChat();
  const [draft, setDraft] = useState("");
  // Lazy initializer: the server renders the default; a client with a stored
  // width differs only in the style attribute, which carries
  // suppressHydrationWarning below (same client-persisted-state situation as
  // the theme class, minus the pre-paint script a whole-page flash demands).
  const [width, setWidth] = useState(readStoredWidth);
  const [resizing, setResizing] = useState(false);
  const [mode, setMode] = useState<DockMode>(readStoredMode);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(readStoredPos);
  const [height, setHeight] = useState<number | null>(readStoredHeight);
  const panelRef = useRef<HTMLElement | null>(null);
  /* One live window-resize drag: which edges move, and where everything
     started. Only floating mode creates one. */
  const winRef = useRef<{
    edges: { n: boolean; e: boolean; s: boolean; w: boolean };
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startPos: { x: number; y: number };
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The element that had focus when the panel opened, so closing can give it back.
  const openerRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number; right: number } | null>(null);
  const moveRef = useRef<{ dx: number; dy: number } | null>(null);
  const floating = mode === "floating";
  const dockedLeft = mode === "docked-left";
  // The resize handle sits on the panel's inner edge, so which way a drag
  // grows the panel flips with the dock side. Floating keeps the right-dock
  // sense (left-edge handle, right edge pinned).
  const growSign = dockedLeft ? -1 : 1;

  const applyWidth = useCallback((value: number) => {
    const next = clampWidth(value);
    setWidth(next);
    storeWidth(next);
    return next;
  }, []);

  const applyMode = useCallback(
    (next: DockMode) => {
      setMode(next);
      try {
        globalThis.localStorage?.setItem(MODE_KEY, next);
      } catch {
        /* non-persisting mode still works */
      }
      if (next === "floating" && pos === null) {
        // First undock: land bottom-right-ish, clear of the topbar.
        setPos(clampPos(window.innerWidth - width - 24, 76, width));
      }
    },
    [pos, width],
  );

  const applyPos = useCallback(
    (x: number, y: number) => {
      const next = clampPos(x, y, width);
      setPos(next);
      try {
        globalThis.localStorage?.setItem(POS_KEY, JSON.stringify(next));
      } catch {
        /* fine */
      }
    },
    [width],
  );

  // Drag the floating window by its header. Buttons and the menu stay
  // clickable: a pointerdown that starts on one never begins a drag.
  const onHeaderPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!floating || pos === null) return;
      if ((event.target as HTMLElement).closest("button,[role=menu]")) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      moveRef.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y };
    },
    [floating, pos],
  );

  const onHeaderPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const move = moveRef.current;
      if (move === null) return;
      setPos(clampPos(event.clientX - move.dx, event.clientY - move.dy, width));
    },
    [width],
  );

  const onHeaderPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const move = moveRef.current;
      if (move === null) return;
      moveRef.current = null;
      applyPos(event.clientX - move.dx, event.clientY - move.dy);
    },
    [applyPos],
  );

  // Pointer drag on the left-edge handle. The panel is right-docked, so
  // dragging left grows it: width = startWidth + (startX - clientX).
  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      // In floating mode the right edge stays put while the left edge moves,
      // so the drag adjusts x and width together.
      dragRef.current = {
        startX: event.clientX,
        startWidth: width,
        right: (pos?.x ?? 0) + width,
      };
      setResizing(true);
    },
    [width, pos],
  );

  const onHandlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const next = clampWidth(drag.startWidth + growSign * (drag.startX - event.clientX));
      setWidth(next);
      if (floating) setPos((p) => (p === null ? p : { ...p, x: drag.right - next }));
    },
    [floating, growSign],
  );

  const onHandlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null) return;
      dragRef.current = null;
      setResizing(false);
      const next = applyWidth(drag.startWidth + growSign * (drag.startX - event.clientX));
      if (floating) applyPos(drag.right - next, pos?.y ?? 76);
    },
    [applyWidth, applyPos, floating, growSign, pos],
  );

  /* Chrome-window resize for the floating mode: any edge or corner drags.
     The math per axis: a right/bottom edge changes only the size; a left/top
     edge changes size and position together so the opposite edge stays put.
     Width reuses the docked clamp; height clamps to the viewport. */
  const onWindowResizeDown = useCallback(
    (edges: { n?: boolean; e?: boolean; s?: boolean; w?: boolean }) =>
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (!floating || pos === null) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = panelRef.current?.getBoundingClientRect();
        winRef.current = {
          edges: { n: !!edges.n, e: !!edges.e, s: !!edges.s, w: !!edges.w },
          startX: event.clientX,
          startY: event.clientY,
          startW: width,
          startH: Math.round(rect?.height ?? height ?? 680),
          startPos: pos,
        };
        setResizing(true);
      },
    [floating, pos, width, height],
  );

  const onWindowResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const win = winRef.current;
    if (win === null) return;
    const dx = event.clientX - win.startX;
    const dy = event.clientY - win.startY;
    let nextW = win.startW;
    let nextH = win.startH;
    let nextX = win.startPos.x;
    let nextY = win.startPos.y;
    if (win.edges.e) nextW = clampWidth(win.startW + dx);
    if (win.edges.w) {
      nextW = clampWidth(win.startW - dx);
      nextX = win.startPos.x + (win.startW - nextW);
    }
    const maxH = window.innerHeight - Math.max(60, nextY) - 8;
    if (win.edges.s) nextH = Math.min(maxH, Math.max(MIN_HEIGHT, win.startH + dy));
    if (win.edges.n) {
      nextH = Math.max(MIN_HEIGHT, win.startH - dy);
      nextY = Math.max(60, win.startPos.y + (win.startH - nextH));
      nextH = Math.min(window.innerHeight - nextY - 8, nextH);
    }
    setWidth(nextW);
    setHeight(Math.round(nextH));
    setPos({ x: nextX, y: nextY });
  }, []);

  const onWindowResizeUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const win = winRef.current;
      if (win === null) return;
      winRef.current = null;
      setResizing(false);
      onWindowResizeMove(event);
      /* Persist the settled geometry. */
      try {
        globalThis.localStorage?.setItem(WIDTH_KEY, String(clampWidth(width)));
        if (height !== null) globalThis.localStorage?.setItem(HEIGHT_KEY, String(height));
        if (pos !== null) globalThis.localStorage?.setItem(POS_KEY, JSON.stringify(pos));
      } catch {
        /* non-persisting mode still works */
      }
    },
    [onWindowResizeMove, width, height, pos],
  );

  /* Publish the dock width so the `fixed` Explore and QuixLab overlays can
     stop at this panel instead of running under it (see lib/shell-breakout.ts
     and the --dock-w note in globals.css). Floating leaves both at 0: that
     mode is a window over the app and its own z-40 clears the overlay. */
  useEffect(() => {
    const root = document.documentElement;
    const docked = enabled && open && !floating ? `${width}px` : "0px";
    root.style.setProperty("--dock-w", dockedLeft ? "0px" : docked);
    root.style.setProperty("--dock-left-w", dockedLeft ? docked : "0px");
    return () => {
      root.style.setProperty("--dock-w", "0px");
      root.style.setProperty("--dock-left-w", "0px");
    };
  }, [enabled, open, width, floating, dockedLeft]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        // Explore's focus mode covers the chrome and inerts it. Opening the
        // panel underneath that cover would leave it unreachable but in the
        // tab order (FR-DM-090), and the focus-mode sweep would then hand
        // back the wrong `inert` on exit. Refuse instead.
        if (document.documentElement.dataset.exploreFocus === "1") return;
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, toggle]);

  // Focus moves in on open and returns to the opener on close. The panel is a
  // dock, not a modal, so focus is never trapped inside it.
  useEffect(() => {
    if (!enabled) return;
    if (open) {
      openerRef.current = document.activeElement as HTMLElement | null;
      inputRef.current?.focus();
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener !== null && document.body.contains(opener)) opener.focus();
  }, [enabled, open]);

  // Keep the newest frame in view as the answer streams in.
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [messages, streaming]);

  if (!enabled) return null;

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || streaming) return;
    send(text);
    setDraft("");
  };

  // Chips fill the composer (they do not send) — the user stays in charge.
  const onSuggestion = (text: string) => {
    setDraft(text);
    inputRef.current?.focus();
  };

  return (
    <aside
      ref={panelRef}
      data-shell-chrome
      aria-label="Assistant"
      aria-hidden={!open}
      inert={!open}
      onKeyDown={(event) => {
        // Escape closes the panel — only while focus is inside it, so the
        // handler never steals Escape from a dialog elsewhere on the page.
        if (event.key !== "Escape") return;
        event.stopPropagation();
        setOpen(false);
      }}
      className={cn(
        "overflow-hidden bg-surface",
        // Docked: one of the two dock slots (col 2 left of content, col 4
        // right of it). The definite column matters — an item with a definite
        // row but an auto column is placed before the auto-flow items, so
        // without it this aside grabs row 2 / column 1 and evicts the sidebar
        // and main content.
        !floating && "relative row-start-2",
        !floating && (dockedLeft ? "col-start-2" : "col-start-4"),
        // Floating: a window over the app. Fixed positioning takes the aside
        // out of grid flow, so the auto column collapses and main reflows.
        floating && "fixed z-40 rounded-lg border border-line shadow-tm-lg",
        // The open/close slide keeps its transition; a live drag must not
        // fight it, so resizing (and window-dragging) switches the animation off.
        !resizing && !floating &&
          "transition-[width,opacity] duration-[280ms] ease-[cubic-bezier(.32,.72,.28,1)]",
        open
          ? cn(!floating && (dockedLeft ? "border-r border-line" : "border-l border-line"), "opacity-100")
          : "pointer-events-none opacity-0",
      )}
      style={
        floating && pos !== null
          ? {
              width: open ? width : 0,
              left: pos.x,
              top: pos.y,
              height: height ?? "min(680px, calc(100vh - 96px))",
            }
          : { width: open ? width : 0 }
      }
      suppressHydrationWarning
    >
      {/* Floating mode resizes like a desktop window: every edge and corner
          drags. Pointer-only affordances (aria-hidden) — keyboard width
          resize stays on the separator below, and a keyboard user can dock
          the panel for the full splitter. Corners render after edges so they
          win the hit test. */}
      {floating && (
        <>
          <div aria-hidden onPointerDown={onWindowResizeDown({ n: true })} onPointerMove={onWindowResizeMove} onPointerUp={onWindowResizeUp} onPointerCancel={onWindowResizeUp} className="absolute inset-x-2 top-0 z-10 h-1.5 cursor-ns-resize touch-none" />
          <div aria-hidden onPointerDown={onWindowResizeDown({ s: true })} onPointerMove={onWindowResizeMove} onPointerUp={onWindowResizeUp} onPointerCancel={onWindowResizeUp} className="absolute inset-x-2 bottom-0 z-10 h-1.5 cursor-ns-resize touch-none" />
          <div aria-hidden onPointerDown={onWindowResizeDown({ e: true })} onPointerMove={onWindowResizeMove} onPointerUp={onWindowResizeUp} onPointerCancel={onWindowResizeUp} className="absolute inset-y-2 right-0 z-10 w-1.5 cursor-ew-resize touch-none" />
          <div aria-hidden onPointerDown={onWindowResizeDown({ w: true })} onPointerMove={onWindowResizeMove} onPointerUp={onWindowResizeUp} onPointerCancel={onWindowResizeUp} className="absolute inset-y-2 left-0 z-10 w-1.5 cursor-ew-resize touch-none" />
          <div aria-hidden onPointerDown={onWindowResizeDown({ n: true, w: true })} onPointerMove={onWindowResizeMove} onPointerUp={onWindowResizeUp} onPointerCancel={onWindowResizeUp} className="absolute top-0 left-0 z-20 size-2.5 cursor-nwse-resize touch-none" />
          <div aria-hidden onPointerDown={onWindowResizeDown({ n: true, e: true })} onPointerMove={onWindowResizeMove} onPointerUp={onWindowResizeUp} onPointerCancel={onWindowResizeUp} className="absolute top-0 right-0 z-20 size-2.5 cursor-nesw-resize touch-none" />
          <div aria-hidden onPointerDown={onWindowResizeDown({ s: true, w: true })} onPointerMove={onWindowResizeMove} onPointerUp={onWindowResizeUp} onPointerCancel={onWindowResizeUp} className="absolute bottom-0 left-0 z-20 size-2.5 cursor-nesw-resize touch-none" />
          <div aria-hidden onPointerDown={onWindowResizeDown({ s: true, e: true })} onPointerMove={onWindowResizeMove} onPointerUp={onWindowResizeUp} onPointerCancel={onWindowResizeUp} className="absolute right-0 bottom-0 z-20 size-2.5 cursor-nwse-resize touch-none" />
        </>
      )}
      {/* The splitter belongs to the dock: in floating mode the window
          handles above own every edge, so the separator would be a second,
          conflicting affordance on the same pixels. */}
      {!floating && (
        <>
          {/* Resize handle on the left edge: drag, arrow keys, double-click resets. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize assistant panel"
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            aria-valuenow={width}
            tabIndex={open ? 0 : -1}
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerUp}
            onDoubleClick={() => applyWidth(DEFAULT_WIDTH)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") applyWidth(width + growSign * KEY_STEP);
              else if (event.key === "ArrowRight") applyWidth(width - growSign * KEY_STEP);
              else if (event.key === "Home") applyWidth(MAX_WIDTH);
              else if (event.key === "End") applyWidth(MIN_WIDTH);
              else return;
              event.preventDefault();
            }}
            className={cn(
              "absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none outline-none",
              // The handle lives on the inner edge: right when docked left,
              // left otherwise (right dock and floating).
              dockedLeft ? "right-0" : "left-0",
              "hover:bg-accent-soft focus-visible:bg-accent-soft",
              resizing && "bg-accent-soft",
            )}
          />
        </>
      )}
      <div className="flex h-full flex-col" style={{ width }} suppressHydrationWarning>
        <div
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
          className={cn(
            "flex items-center gap-2.5 border-b border-line-2 px-4 pt-[13px] pb-[11px]",
            floating && "cursor-move touch-none select-none",
          )}
        >
          <div className="font-bold tracking-[-0.01em]">
            Assistant
            <small className="block text-[0.65rem] font-medium tracking-[0.06em] text-ink-3 uppercase">
              Registry · read-only
            </small>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              title="Panel position"
              aria-label="Panel position"
              className="ml-auto grid size-[30px] place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2"
            >
              <PanelRight size={15} strokeWidth={2} aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={floating} onClick={() => applyMode("floating")}>
                <PictureInPicture2 size={14} strokeWidth={2} aria-hidden />
                Undock
              </DropdownMenuItem>
              <DropdownMenuItem disabled={dockedLeft} onClick={() => applyMode("docked-left")}>
                <PanelLeft size={14} strokeWidth={2} aria-hidden />
                Dock left
              </DropdownMenuItem>
              <DropdownMenuItem disabled={mode === "docked"} onClick={() => applyMode("docked")}>
                <PanelRight size={14} strokeWidth={2} aria-hidden />
                Dock right
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Close"
            aria-label="Close assistant"
            className="grid size-[30px] place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2"
          >
            <X size={15} strokeWidth={2} aria-hidden />
          </button>
        </div>

        {/* The trust contract, stated where the user reads it. */}
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-accent-soft-border bg-accent-soft px-[11px] py-2 text-[0.72rem] leading-[1.4] text-ink-2">
          <Lock size={13} strokeWidth={2} aria-hidden className="mt-px flex-none text-primary" />
          <span>
            <b className="font-semibold text-primary">Reads the registry. Never edits.</b> Every
            answer links to the screen that proves it — nothing here is generated data.
          </span>
        </div>

        <div ref={scrollRef} role="log" aria-live="polite" className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pt-3.5 pb-1.5">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((message, index) =>
              message.role === "user" ? (
                <UserTurn key={index} text={message.text} />
              ) : (
                <AssistantTurn
                  key={index}
                  message={message}
                  streaming={streaming && index === messages.length - 1}
                />
              ),
            )
          )}

          {error !== null && (
            <div
              role="alert"
              className="rounded-md border border-red-border bg-red-bg px-3.5 py-2 text-[0.76rem] text-red"
            >
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-line-2 px-4 pt-2.5 pb-3.5">
          <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Suggested questions">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onSuggestion(suggestion)}
                className="rounded-full border border-line bg-surface-2 px-2.5 py-[3px] text-[0.7rem] font-semibold text-ink-2 transition-colors hover:border-accent-soft-border hover:bg-accent-soft hover:text-primary"
              >
                {suggestion}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 py-2 pr-2 pl-3 transition-colors focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask about runs, files, signals, work orders…"
              aria-label="Ask about runs, files, signals, work orders"
              disabled={streaming}
              className="flex-1 bg-transparent text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={submit}
              title="Send"
              aria-label="Send"
              aria-busy={streaming}
              disabled={streaming || draft.trim().length === 0}
              className="grid size-7 flex-none place-items-center rounded-[5px] bg-accent-fill text-accent-ink transition-colors hover:bg-accent-fill-hover disabled:opacity-50"
            >
              <Send size={13} strokeWidth={2} aria-hidden />
            </button>
          </div>
          <div className="mt-2 text-center text-[0.64rem] text-ink-3">
            Answers cite the registry. Verify in the linked screen before acting.
          </div>
        </div>
      </div>
    </aside>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <span
        aria-hidden
        className="grid size-9 place-items-center rounded-full bg-accent-soft text-primary"
      >
        <MessageCircle size={16} strokeWidth={2} />
      </span>
      <p className="text-[0.82rem] font-semibold text-ink">Ask the registry</p>
      <p className="max-w-sm text-[0.76rem] text-ink-3">
        Find runs, files, signals and work orders in plain language. Every answer links to the
        screen that proves it. Try a suggestion below to start.
      </p>
    </div>
  );
}
