"use client";

import { cn } from "@/lib/utils";

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  message = "Something went wrong loading this data.",
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div role="alert" className={cn("px-4 py-[22px] text-center text-[0.78rem]", className)}>
      <div className="font-semibold text-red">{message}</div>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md border border-line bg-surface px-3 py-1.5 text-[0.74rem] font-semibold text-ink-2 transition-colors hover:border-line-strong hover:bg-surface-2"
        >
          Retry
        </button>
      )}
    </div>
  );
}
