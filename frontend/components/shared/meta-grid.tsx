import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SourceBadge, type SourceKind } from "./source-badge";

interface MetaGridProps {
  children: ReactNode;
  className?: string;
}

export function MetaGrid({ children, className }: MetaGridProps) {
  return (
    <div className={cn("grid grid-cols-4 border-t border-line-2", className)}>
      {children}
    </div>
  );
}

interface MetaCellProps {
  label: ReactNode;
  source?: SourceKind;
  muted?: boolean;
  children: ReactNode;
  className?: string;
}

export function MetaCell({ label, source, muted = false, children, className }: MetaCellProps) {
  return (
    <div
      className={cn(
        "border-r border-b border-line-2 px-4 py-[11px] [&:nth-child(4n)]:border-r-0",
        className
      )}
    >
      <div className="mb-[3px] flex items-center gap-1.5 text-[0.63rem] font-semibold tracking-[0.08em] text-ink-3 uppercase">
        {label}
        {source !== undefined && <SourceBadge source={source} />}
      </div>
      <div className={cn("text-[0.8rem] font-medium", muted && "text-ink-3")}>{children}</div>
    </div>
  );
}
