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
 * scroll on these screens.
 *
 * `data-full-height` is the marker AppShell's two `:has()` rules read: they
 * cut the shell's bottom padding to a hairline and give the max-width column a
 * definite height, so `h-full` here resolves to the whole main column and no
 * viewport arithmetic is duplicated out of the shell.
 *
 * Non-list pages (Home + detail screens) do NOT use this wrapper and keep the
 * shell's normal top-of-page scroll behavior.
 */
export function FullHeightPage({ children, className }: FullHeightPageProps) {
  return (
    <div data-full-height className={cn("flex h-full min-h-0 flex-col", className)}>
      {children}
    </div>
  );
}
