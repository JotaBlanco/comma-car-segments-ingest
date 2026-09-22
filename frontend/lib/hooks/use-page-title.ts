"use client";

import { useEffect } from "react";
import { pageTitle } from "@/lib/page-title";

/**
 * Set `document.title` for a client-rendered detail screen (FR-DM-091).
 *
 * The app is fully client-rendered: a detail route knows its title only once
 * the entity loads, so static `metadata` cannot name it. Pass `null` while
 * loading — the layout default stays up until the entity arrives, and the
 * title then changes right as the content does, which is what a screen
 * reader announces after `FocusOnRouteChange` moves focus to `<main>`.
 *
 * No cleanup on purpose: every route sets its own title (per-segment
 * `metadata` or this hook), so restoring the previous one would only flash
 * a stale title during navigation.
 */
export function usePageTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    document.title = pageTitle(title);
  }, [title]);
}
