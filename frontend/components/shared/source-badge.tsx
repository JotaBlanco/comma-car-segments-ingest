"use client";

import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { sourceMeaning } from "@/types/source";

export type SourceKind = "embedded" | "manual" | `api:${string}`;

interface SourceBadgeProps {
  source: SourceKind;
  className?: string;
}

const variantClass = {
  embedded: "border-line bg-muted text-ink-2",
  api: "border-accent-soft-border bg-accent-soft text-primary",
  manual: "border-amber-border bg-amber-bg text-amber",
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
 * The tooltip mounts on the first hover or the first focus. One badge rides on
 * every row of every table, and a mounted tooltip costs real work per badge,
 * so a long table pays for the plain span alone until a person asks.
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

  const variant = source === "embedded" || source === "manual" ? source : "api";
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
