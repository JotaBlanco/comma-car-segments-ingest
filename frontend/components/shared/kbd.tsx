"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { CTRL_MODIFIER, MAC_MODIFIER, isMac } from "@/lib/platform";

/** Platform never changes for the life of the page, so nothing to subscribe to. */
const subscribe = () => () => {};
/** Client snapshot: the real platform. */
const getSnapshot = () => isMac();
/** Server / hydration snapshot: assume macOS so first paint matches the server. */
const getServerSnapshot = () => true;

interface KbdProps {
  /** The key portion of the shortcut, e.g. "K" for ⌘K / Ctrl K. */
  keyLabel: string;
  /** Extra classes merged onto the badge — pass the surrounding visual style. */
  className?: string;
}

/**
 * Platform-aware keyboard-shortcut badge.
 *
 * Renders "⌘K" on macOS and "Ctrl K" on Windows / Linux.
 *
 * Hydration: `useSyncExternalStore` renders the macOS glyph on the server and
 * during hydration (via `getServerSnapshot`) so server and client markup match
 * exactly, then switches to the real platform snapshot on the client. This is
 * the canonical SSR-safe pattern and avoids a hydration mismatch without a
 * post-mount `setState`. `suppressHydrationWarning` covers the transient
 * one-frame text difference on non-Mac clients.
 */
export function Kbd({ keyLabel, className }: KbdProps) {
  const mac = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const modifier = mac ? MAC_MODIFIER : CTRL_MODIFIER;
  // ⌘ sits flush against the key ("⌘K"); "Ctrl" reads better spaced ("Ctrl K").
  const separator = mac ? "" : " ";

  return (
    <kbd
      className={cn(
        "rounded-sm border border-line bg-surface px-[5px] py-px font-mono text-[0.65rem]",
        className,
      )}
      suppressHydrationWarning
    >
      {modifier}
      {separator}
      {keyLabel}
    </kbd>
  );
}
