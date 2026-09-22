import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title?: string;
  message?: ReactNode;
  className?: string;
}

export function EmptyState({ title, message, className }: EmptyStateProps) {
  return (
    <div className={cn("px-4 py-[22px] text-center text-[0.78rem] text-ink-3", className)}>
      {title !== undefined && <div className="mb-0.5 font-semibold text-ink-2">{title}</div>}
      {message ?? "Nothing here yet."}
    </div>
  );
}
