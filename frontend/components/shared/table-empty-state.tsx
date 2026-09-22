"use client";

import { cn } from "@/lib/utils";

/**
 * Empty-state row for the table body (spec §2.7).
 *
 * Rendered by each screen as `<tr>` with a single full-width `<td colSpan>` when the current
 * filter/search state matches no rows. The action button calls `onClearAll` — the same
 * handler backing the pills bar and the `useTableState.clearAll()` helper — so the user has
 * one recovery affordance instead of hunting for each applied filter.
 */

export interface TableEmptyStateProps {
  readonly colSpan: number;
  readonly onClearAll: () => void;
  readonly message?: string;
  readonly actionLabel?: string;
  readonly className?: string;
}

export function TableEmptyState({
  colSpan,
  onClearAll,
  message = "Nothing matches the current filters.",
  actionLabel = "Clear everything",
  className,
}: TableEmptyStateProps) {
  return (
    <tr className="hover:bg-transparent">
      <td
        colSpan={colSpan}
        /* The empty state swaps in after a fetch, so it must announce itself —
           without a live region a screen reader hears nothing change. */
        role="status"
        className={cn("px-4 py-7 text-center text-[0.78rem] text-ink-3", className)}
      >
        {message}{" "}
        <button
          type="button"
          onClick={onClearAll}
          className="font-semibold text-primary hover:text-accent-fill-hover"
        >
          {actionLabel}
        </button>
      </td>
    </tr>
  );
}
