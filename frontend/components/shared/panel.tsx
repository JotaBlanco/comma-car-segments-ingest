import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PanelProps {
  children: ReactNode;
  className?: string;
}

export function Panel({ children, className }: PanelProps) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-line bg-surface", className)}>
      {children}
    </div>
  );
}

interface PanelHeadProps {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
  /**
   * The heading level of the panel title (FR-DM-091). A `<div>` kept every
   * panel out of the document outline, so a screen reader's heading rotor
   * saw one page as one flat block. `h2` sits under each screen's `h1`;
   * pass `h3` for a panel nested under an `h2` section.
   */
  as?: "h2" | "h3";
}

export function PanelHead({ title, action, className, as: Heading = "h2" }: PanelHeadProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b border-line-2 px-4 py-[11px]",
        className
      )}
    >
      <Heading className="text-[0.82rem] font-bold tracking-[-0.01em]">{title}</Heading>
      {action}
    </div>
  );
}

interface TableScrollAreaProps {
  children: ReactNode;
  className?: string;
}

/**
 * Vertical scroll wrapper for tables inside a full-height Panel.
 *
 * - `min-h-0 flex-1 overflow-y-auto` — flex-fills remaining Panel space and
 *   contains the row scroll so TablePager stays pinned at the panel bottom.
 * - The `.table-scroll` class is targeted by globals.css to sticky-pin the
 *   column-header row (`thead th`) with an inset shadow that preserves the
 *   header/body separator during scroll (some browsers drop `border-bottom`
 *   on sticky cells).
 * - Neutralises the shadcn Table's inner `overflow-x-auto` container so this
 *   wrapper is the sticky scroll ancestor for the `th`s.
 */
export function TableScrollArea({ children, className }: TableScrollAreaProps) {
  return (
    <div className={cn("table-scroll min-h-0 flex-1 overflow-y-auto", className)}>{children}</div>
  );
}
