"use client";

import { useEffect, useRef } from "react";
import { useAnnounce } from "@/lib/hooks/use-announce";
import { cn } from "@/lib/utils";

/**
 * Sortable table header cell (spec §2.6).
 *
 * - Renders a `<th aria-sort={...}>` (WCAG: aria-sort communicates active + direction).
 * - Contains a full-width `<button>` so the header is keyboard-activatable.
 * - Arrow ↑ / ↓ is only visible when this header is the active sort key (accent color).
 * - Toggle strategy lives in the caller (`setSort` handles it) — this component only
 *   forwards `onSort(sortKey)`.
 */

export interface SortableThProps {
  readonly label: string;
  readonly sortKey: string;
  readonly active: { key: string; order: "asc" | "desc" } | null;
  readonly onSort: (key: string) => void;
  /** Right-align (numeric columns). */
  readonly numeric?: boolean;
  readonly className?: string;
}

export function SortableTh({
  label,
  sortKey,
  active,
  onSort,
  numeric = false,
  className,
}: SortableThProps) {
  const isActive = active !== null && active.key === sortKey;
  const ariaSort: "ascending" | "descending" | "none" = isActive
    ? active.order === "asc"
      ? "ascending"
      : "descending"
    : "none";
  const arrow = isActive ? (active.order === "asc" ? "↑" : "↓") : null;

  /* A sort flip changes `aria-sort`, which no screen reader announces by
     itself — say it through the shared polite region (FR-DM-091). Only the
     header that IS the active sort speaks, and only on a change. */
  const announce = useAnnounce();
  const spoken = isActive ? `Sorted by ${label}, ${ariaSort}` : null;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (spoken !== null) announce(spoken);
  }, [announce, spoken]);

  return (
    <th
      aria-sort={ariaSort}
      className={cn(numeric && "text-right! font-sans", className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex w-full items-center gap-1 bg-transparent text-inherit uppercase tracking-[inherit] transition-colors hover:text-ink-2",
          numeric && "justify-end"
        )}
      >
        <span>{label}</span>
        {arrow !== null && (
          <span aria-hidden className="text-[0.7rem] text-primary">
            {arrow}
          </span>
        )}
      </button>
    </th>
  );
}
