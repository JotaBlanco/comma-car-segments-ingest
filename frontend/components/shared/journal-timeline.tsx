"use client";

import { SourceBadge } from "@/components/shared/source-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { VerifiedActorMark } from "@/components/shared/verified-actor-mark";
import { formatArrival } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { JournalEntry } from "@/types";

function dotVariant(source: JournalEntry["source"]): "manual" | "api" | "system" {
  if (source === "manual") return "manual";
  if (source.startsWith("api:")) return "api";
  return "system";
}

const dotClass = {
  manual: "border-amber-border bg-amber-bg text-amber",
  api: "border-accent-soft-border bg-accent-soft text-primary",
  system: "border-line bg-surface-2 text-ink-3",
} as const;

function DotIcon({ variant }: { variant: "manual" | "api" | "system" }) {
  if (variant === "manual") {
    return (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
        <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
      </svg>
    );
  }
  if (variant === "api") {
    return (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
      <path d="M21 12a9 9 0 1 1-9-9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

interface JournalTimelineProps {
  entries: JournalEntry[];
}

export function JournalTimeline({ entries }: JournalTimelineProps) {
  if (entries.length === 0) {
    return <EmptyState title="No journal entries" message="Changes and events will appear here." />;
  }
  return (
    <div className="py-1.5">
      {entries.map((entry) => {
        const variant = dotVariant(entry.source);
        const hasDiff = entry.kind === "change" && (entry.old !== null || entry.new !== null);
        return (
          <div
            key={entry.id}
            className="relative flex gap-3.5 px-5 py-3 before:absolute before:top-0 before:bottom-0 before:left-[30px] before:w-px before:bg-line-2 last:before:hidden"
          >
            <div
              className={cn(
                "z-1 grid size-[22px] flex-none place-items-center rounded-full border",
                dotClass[variant]
              )}
            >
              <DotIcon variant={variant} />
            </div>
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {entry.field !== null && (
                  <span className="font-mono text-[0.74rem] font-semibold">{entry.field}</span>
                )}
                <SourceBadge source={entry.source} />
                <span className="ml-auto text-[0.7rem] whitespace-nowrap text-ink-3">
                  {entry.actor}
                  <VerifiedActorMark actorId={entry.actor_id} />
                  {" · "}
                  {formatArrival(entry.at)}
                </span>
              </div>
              {hasDiff && (
                <div className="mt-[5px] flex flex-wrap items-center gap-2 font-mono text-[0.72rem]">
                  {/* The strikethrough and the red/green fill carry which side
                      is which, so a screen reader (and a user who cannot tell
                      red from green) needs the words spelled out. */}
                  <span className="rounded-[3px] bg-red-bg px-1.5 py-px text-red line-through decoration-1">
                    <span className="sr-only">Old value: </span>
                    {entry.old ?? "(empty)"}
                  </span>
                  <span aria-hidden>→</span>
                  <span className="rounded-[3px] bg-green-bg px-1.5 py-px text-green">
                    <span className="sr-only">New value: </span>
                    {entry.new ?? "(empty)"}
                  </span>
                </div>
              )}
              {entry.note !== null && (
                <div className="mt-1 text-[0.78rem] text-ink-2">{entry.note}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
