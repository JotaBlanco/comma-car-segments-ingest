import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type RunStatus = "complete" | "awaiting_work_order" | "invalid";
export type FileStatus = "registered" | "quarantined";
export type BadgeStatus = RunStatus | FileStatus;

export type BadgeTone = "green" | "amber" | "red" | "neutral";

const statusConfig: Record<BadgeStatus, { label: string; tone: BadgeTone }> = {
  complete: { label: "Linked", tone: "green" },
  awaiting_work_order: { label: "Awaiting work order", tone: "amber" },
  invalid: { label: "Invalid", tone: "red" },
  registered: { label: "Registered", tone: "green" },
  quarantined: { label: "Quarantined", tone: "red" },
};

const toneClass: Record<BadgeTone, string> = {
  green: "bg-green-bg text-green",
  amber: "bg-amber-bg text-amber",
  red: "bg-red-bg text-red",
  neutral: "bg-muted text-ink-2",
};

const dotClass: Record<BadgeTone, string> = {
  green: "bg-green-dot",
  amber: "bg-amber-dot",
  red: "bg-red-dot",
  neutral: "bg-ink-3",
};

interface ToneBadgeProps {
  tone: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

export function ToneBadge({ tone, dot = false, children, className }: ToneBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] rounded-sm px-[7px] py-0.5 text-[0.68rem] font-semibold tracking-[0.02em] whitespace-nowrap",
        toneClass[tone],
        className
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", dotClass[tone])} />}
      {children}
    </span>
  );
}

interface StatusBadgeProps {
  status: BadgeStatus;
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const config = statusConfig[status];
  return (
    <ToneBadge tone={config.tone} dot className={className}>
      {label ?? config.label}
    </ToneBadge>
  );
}

/** Planned versus actual on a test definition. The work-order detail, the
    definitions list and the definition detail all print the same badge. */
export type DefinitionBadgeStatus = "on_plan" | "awaiting_data";

export function DefinitionStatusBadge({ status }: { status: DefinitionBadgeStatus }) {
  if (status === "on_plan") {
    return (
      <ToneBadge tone="green" dot>
        On plan
      </ToneBadge>
    );
  }
  return (
    <ToneBadge tone="amber" dot>
      Awaiting data
    </ToneBadge>
  );
}
