"use client";

import { cn } from "@/lib/utils";

/**
 * Segmented control for table quick views (All / Needs attention / Invalid, etc).
 *
 * - `count` is optional per view: when absent → no badge renders (clean degradation when the
 *   list envelope's `view_counts` are unavailable — spec §2.1).
 * - Buttons expose `aria-pressed` so deep-link e2e assertions can target them by
 *   `getByRole("button", { name: "Quarantined", pressed: true })`.
 * - Mock parity: `bg-ink` fill for the active button (matches `.segment button.active`).
 * - Dark theme: `--ink` is white there, so the inverted fill would turn the active button
 *   into a white block. Dark takes `--accent-fill` instead — the same solid fill
 *   `Button`/`Badge` use for their default variant (white on it reads 4.92:1).
 */

export interface QuickView {
  readonly id: string;
  readonly label: string;
  /** Absent → no badge is rendered. */
  readonly count?: number;
}

export interface QuickViewSegmentProps {
  readonly views: readonly QuickView[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  /** Accessible name for the segmented control group, e.g. "Run quick views". */
  readonly "aria-label": string;
  readonly className?: string;
}

export function QuickViewSegment({
  views,
  activeId,
  onSelect,
  "aria-label": ariaLabel,
  className,
}: QuickViewSegmentProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex overflow-hidden rounded-md border border-line bg-surface",
        className
      )}
    >
      {views.map((view, index) => {
        const active = view.id === activeId;
        return (
          <button
            key={view.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(view.id)}
            className={cn(
              "px-3 py-1.5 text-[0.76rem] font-semibold text-ink-2 transition-colors",
              index > 0 && "border-l border-line-2",
              active
                ? "bg-ink text-bg dark:bg-accent-fill dark:text-accent-ink"
                : "hover:bg-surface-2"
            )}
          >
            {view.label}
            {view.count !== undefined && (
              <span
                className={cn(
                  "ml-1.5 font-mono text-[0.68rem]",
                  // Inactive: use ink-3 (WCAG AA 4.56:1 on --surface). The
                  // active state runs `text-bg` on `bg-ink` (contrast > 15:1),
                  // so a small opacity keeps it de-emphasised without failing
                  // AA. Previously `opacity-65` on the inactive tab produced
                  // ~3.33:1 (light) — an axe color-contrast violation.
                  // Dark drops the opacity: white on `--accent-fill` is 4.92:1
                  // at full strength and only 3.67:1 at 80%.
                  active ? "text-bg/80 dark:text-accent-ink" : "text-ink-3"
                )}
              >
                {view.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
