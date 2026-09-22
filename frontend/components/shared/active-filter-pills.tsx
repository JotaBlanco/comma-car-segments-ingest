"use client";

import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Applied" filter pills row, rendered above the table (spec §2.4).
 *
 * - Renders `null` when there are no pills — the row disappears completely; no leftover
 *   spacing.
 * - Search / pass-through params show the same shape as multi-select filters so every URL
 *   state is visibly removable.
 * - Each × button has an explicit `aria-label` ("Remove filter: Status Invalid") for
 *   screen-reader clarity — icon-only buttons must be labeled.
 * - "Clear all" appears only when ≥1 pill.
 */

export interface FilterPill {
  /** Stable key, e.g. "status:invalid" or "q" or "signal". */
  readonly id: string;
  /** Small-caps prefix: "Status", "Search", "Signal". */
  readonly group: string;
  /** Visible value: "Invalid", "“derate”", "HV_Batt_Cell_Temp_Max". */
  readonly label: string;
  readonly onRemove: () => void;
}

export interface ActiveFilterPillsProps {
  readonly pills: readonly FilterPill[];
  readonly onClearAll: () => void;
  readonly className?: string;
}

export function ActiveFilterPills({ pills, onClearAll, className }: ActiveFilterPillsProps) {
  if (pills.length === 0) return null;
  return (
    <div className={cn("mb-2.5 flex flex-wrap items-center gap-1.5", className)}>
      {/* Pills inside role="list"; the "Clear all" action lives outside it —
          role="list" must only contain role="listitem" children (WCAG axe:
          aria-required-children). role+aria-label is preserved on an inner
          wrapper so the flex layout on the outer container still applies to
          both the list and "Clear all". */}
      <div
        role="list"
        aria-label="Applied filters"
        className="flex flex-wrap items-center gap-1.5"
      >
        {pills.map((pill) => (
          <span
            key={pill.id}
            role="listitem"
            className="inline-flex items-center gap-1.5 rounded-full border border-accent-soft-border bg-accent-soft py-[3px] pr-[3px] pl-2.5 text-[0.72rem] font-semibold text-primary"
          >
            {/* Prefix (group) — full-opacity primary for WCAG AA contrast on
                the accent-soft wash (previously `text-primary/65` failed 4.5:1). */}
            <span className="text-[0.62rem] font-bold tracking-[0.05em] text-primary uppercase">
              {pill.group}
            </span>
            <span>{pill.label}</span>
            <button
              type="button"
              onClick={pill.onRemove}
              aria-label={`Remove filter: ${pill.group} ${pill.label}`}
              className="grid size-4 place-items-center rounded-full hover:bg-accent-soft-border"
            >
              <XIcon aria-hidden className="size-2.5" />
            </button>
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={onClearAll}
        className="px-1.5 py-0.5 text-[0.72rem] font-semibold text-ink-3 hover:text-red"
      >
        Clear all
      </button>
    </div>
  );
}
