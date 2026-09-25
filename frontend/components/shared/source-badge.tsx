"use client";

import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { sourceMeaning } from "@/types/source";

export type SourceKind = "embedded" | "manual" | "derived" | `api:${string}`;

interface SourceBadgeProps {
  source: SourceKind;
  className?: string;
}

const variantClass = {
  embedded: "border-line bg-muted text-ink-2",
  api: "border-accent-soft-border bg-accent-soft text-primary",
  manual: "border-amber-border bg-amber-bg text-amber",
  /* Dashed = computed, generalised from the board's one dashed `Tested` box
     to every derived attribute (requirements-page spec §5). A border-STYLE,
     not a colour, so it costs no contrast ratio and survives dark mode and a
     monochrome print unchanged. */
  derived: "border-dashed border-line bg-transparent text-ink-3",
} as const;

/**
 * The tag alone is the API's own vocabulary, so a reader cannot decode it. The
 * tooltip states who wrote the value, and `aria-label` repeats it, so a screen
 * reader gets the meaning without opening the tooltip.
 *
 * The trigger renders a span, not the default button: the badge sits inside
 * links, table cells and filter labels, and a nested control breaks them.
 * `tabIndex` keeps the tooltip reachable by keyboard, so it is not hover-only.
 *
 * The badge is used only in provenance views (audit trail, ingestion timeline)
 * where the source is the subject matter. Displaying it elsewhere adds
 * scanning cost without communicating actionable information.
 */
export function SourceBadge({ source, className }: SourceBadgeProps) {
  // null = nobody reached this badge yet, so no tooltip exists.
  const [open, setOpen] = useState<boolean | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  // Mounting the tooltip replaces the span with an equal one, so a keyboard
  // focus that mounted it would land on nothing. Give the place back.
  const keepFocus = useRef(false);

  useEffect(() => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    ref.current?.focus();
  });

  const variant =
    source === "embedded" || source === "manual" || source === "derived" ? source : "api";
  const meaning = sourceMeaning(source);
  const reached = open !== null;

  const badge = (
    <span
      ref={ref}
      role="note"
      tabIndex={0}
      aria-label={`${source}. ${meaning}`}
      onPointerEnter={reached ? undefined : () => setOpen(true)}
      onFocus={
        reached
          ? undefined
          : () => {
              keepFocus.current = true;
              setOpen(true);
            }
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-[3px] border px-[5px] py-px align-[1px] font-mono text-[0.6rem] font-medium focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        variantClass[variant],
        className
      )}
    >
      {source}
    </span>
  );

  if (!reached) return badge;
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger delay={200} render={badge} />
      <TooltipContent>{meaning}</TooltipContent>
    </Tooltip>
  );
}
