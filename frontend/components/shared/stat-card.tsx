"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  metaTone?: "default" | "up";
  /** The card's query failed. The card says so out loud — a silent dash
      reads as "zero of something", which is a lie on a stat card. */
  isError?: boolean;
  href?: string;
  onClick?: () => void;
  className?: string;
}

export function StatCard({
  label,
  value,
  meta,
  metaTone = "default",
  isError = false,
  href,
  onClick,
  className,
}: StatCardProps) {
  const cardClass = cn(
    "block w-full rounded-md border border-line bg-surface px-4 py-3.5 text-left transition-[border-color,box-shadow]",
    (href !== undefined || onClick !== undefined) && "hover:border-line-strong hover:shadow-tm",
    className
  );
  const content = (
    <>
      <div className="text-[0.68rem] font-semibold tracking-[0.08em] text-ink-3 uppercase">
        {label}
      </div>
      {/* On error the value slot states the failure — same red as ErrorState,
          and role="alert" so a screen reader hears it. The meta line goes with
          it: "+0 today" under a failed count would state a number nobody has. */}
      {isError ? (
        <div role="alert" className="mt-1 text-[0.8rem] leading-[1.6rem] font-semibold text-red">
          Failed to load
        </div>
      ) : (
        <>
          <div className="mt-1 font-mono text-[1.6rem] leading-tight font-semibold tracking-[-0.02em]">
            {value}
          </div>
          {meta !== undefined && (
            <div
              className={cn("mt-0.5 text-[0.72rem]", metaTone === "up" ? "text-green" : "text-ink-3")}
            >
              {meta}
            </div>
          )}
        </>
      )}
    </>
  );

  if (href !== undefined) {
    return (
      <Link href={href} className={cardClass}>
        {content}
      </Link>
    );
  }
  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={cardClass}>
        {content}
      </button>
    );
  }
  return <div className={cardClass}>{content}</div>;
}
