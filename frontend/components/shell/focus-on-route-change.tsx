"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Move keyboard focus to `<main id="main-content">` after every client-side
 * navigation (FR-DM-090/091).
 *
 * Next.js swaps the page content without a document load, so focus otherwise
 * stays on the link that was clicked — a screen reader hears nothing and a
 * keyboard user keeps tabbing from the old position. Focusing `<main>` is
 * uniform across routes and composes with the per-route `document.title`: the
 * user hears the new title, then "main", then reads the new page.
 *
 * The first render is a real document load — the browser handles focus there,
 * so the effect only acts on CHANGES of the pathname.
 */
export function FocusOnRouteChange() {
  const pathname = usePathname();
  const previous = useRef(pathname);

  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    document.getElementById("main-content")?.focus();
  }, [pathname]);

  return null;
}
