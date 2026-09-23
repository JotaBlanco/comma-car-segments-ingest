import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: ReactNode;
  sub?: ReactNode;
  className?: string;
}

export function PageHeader({ title, sub, className }: PageHeaderProps) {
  return (
    <div className={cn("mb-3", className)}>
      <h1 className="text-[1.45rem] font-bold tracking-[-0.02em]">{title}</h1>
      {sub !== undefined && <div className="mt-0.5 text-ink-3">{sub}</div>}
    </div>
  );
}
