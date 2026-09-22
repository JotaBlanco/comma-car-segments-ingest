import { Activity, Check, Clock, Search, type LucideIcon } from "lucide-react";
import { SourceBadge } from "@/components/shared/source-badge";
import { VerifiedActorMark } from "@/components/shared/verified-actor-mark";
import type { JournalEntry } from "@/types";
import { cn } from "@/lib/utils";
import { formatClock } from "./format";

const FIELD_ICONS: Record<string, LucideIcon> = {
  "file.detected": Search,
  "file.checksum_verified": Check,
  "file.header_parsed": Activity,
  "file.registered": Clock,
};

interface IngestionTimelineProps {
  entries: JournalEntry[];
}

export function IngestionTimeline({ entries }: IngestionTimelineProps) {
  return (
    <div className="py-1.5">
      {entries.map((entry, index) => {
        const Icon = FIELD_ICONS[entry.field ?? ""] ?? Clock;
        const isManual = entry.source === "manual";
        return (
          <div key={entry.id} className="relative flex gap-3.5 px-5 py-3">
            {index < entries.length - 1 && (
              <span
                aria-hidden
                className="absolute top-[34px] -bottom-1 left-[31px] w-px bg-line"
              />
            )}
            <span
              className={cn(
                "z-1 grid size-[22px] flex-none place-items-center rounded-full border border-line bg-surface-2 text-ink-3",
                isManual && "border-amber-border bg-amber-bg text-amber"
              )}
            >
              <Icon className="size-2.5" strokeWidth={2.6} />
            </span>
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[0.74rem] font-semibold">{entry.field}</span>
                <SourceBadge source={entry.source} />
                <span className="ml-auto text-[0.7rem] whitespace-nowrap text-ink-3">
                  {entry.actor}
                  <VerifiedActorMark actorId={entry.actor_id} />
                  {" · "}
                  {formatClock(entry.at)}
                </span>
              </div>
              {entry.old !== null && entry.new !== null && (
                <div className="mt-[5px] flex flex-wrap items-center gap-2 font-mono text-[0.72rem]">
                  {/* Same contract as journal-timeline.tsx: the colours alone
                      must not carry old vs new, and the arrow is decoration —
                      hidden so it is never read as "right arrow". */}
                  <span className="rounded-[3px] bg-red-bg px-1.5 py-px text-red line-through">
                    <span className="sr-only">Old value: </span>
                    {entry.old}
                  </span>
                  <span aria-hidden>→</span>
                  <span className="rounded-[3px] bg-green-bg px-1.5 py-px text-green">
                    <span className="sr-only">New value: </span>
                    {entry.new}
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
