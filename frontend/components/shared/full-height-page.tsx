import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FullHeightPageProps {
  children: ReactNode;
  className?: string;
}

/**
 * Opt-in layout for list screens (spec: /runs, /files, /signals, /work-orders).
 *
 * Fills the AppShell main column height so its Panel child can flex-fill and
 * scroll internally — page header + toolbar + pills stay pinned at the top,
 * the pager stays pinned at the panel bottom, and there is no whole-page
 * scroll on these screens. AppShell already gives its inner max-width column
 * `min-h-full flex flex-col`, so `flex-1 min-h-0` here consumes that height.
 *
 * Non-list pages (Home + detail screens) do NOT use this wrapper and keep the
 * shell's normal top-of-page scroll behavior.
 */
export function FullHeightPage({ children, className }: FullHeightPageProps) {
  return (
    // 142px = 52px topbar + 26px main pt + 64px main pb. An explicit cap is
    // required: the shell column is min-h-full (it can grow past the viewport),
    // so flex-1 alone never clamps the panel and the whole page scrolls.
    <div className={cn("flex h-[calc(100dvh-142px)] min-h-0 flex-col", className)}>
      {children}
    </div>
  );
}
