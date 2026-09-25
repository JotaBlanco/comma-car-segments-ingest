import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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
  muted?: boolean;
  children: ReactNode;
  className?: string;
}

export function MetaCell({ label, muted = false, children, className }: MetaCellProps) {
  return (
    <div
      className={cn(
        "border-r border-b border-line-2 px-4 py-[11px] [&:nth-child(4n)]:border-r-0",
        className
      )}
    >
      <div className="mb-[3px] text-[0.63rem] font-semibold tracking-[0.08em] text-ink-3 uppercase">
        {label}
      </div>
      <div className={cn("text-[0.8rem] font-medium", muted && "text-ink-3")}>{children}</div>
    </div>
  );
}
