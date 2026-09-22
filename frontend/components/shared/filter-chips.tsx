"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ChipRowProps {
  children: ReactNode;
  className?: string;
}

export function ChipRow({ children, className }: ChipRowProps) {
  return <div className={cn("mb-3 flex items-center gap-2", className)}>{children}</div>;
}

interface ChipProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}

export function Chip({ active = false, onClick, children, className }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border border-line bg-surface px-[11px] py-[5px] text-[0.74rem] font-semibold text-ink-2 transition-colors",
        active
          ? "border-ink bg-ink text-bg dark:border-accent-fill dark:bg-accent-fill dark:text-accent-ink"
          : "hover:border-line-strong",
        className
      )}
    >
      {children}
    </button>
  );
}
