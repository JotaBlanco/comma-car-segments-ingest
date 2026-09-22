"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface NodeCardProps {
  label: string;
  badge?: ReactNode;
  title: string;
  sub?: ReactNode;
  href?: string;
  className?: string;
  children?: ReactNode;
}

export function NodeCard({ label, badge, title, sub, href, className, children }: NodeCardProps) {
  const body = (
    <>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[0.6rem] font-semibold tracking-[0.09em] text-ink-3 uppercase">
          {label}
        </span>
        {badge}
      </div>
      <span className="font-mono text-[0.85rem] font-semibold">{title}</span>
      {sub !== undefined && <div className="mt-0.5 text-[0.72rem] text-ink-3">{sub}</div>}
      {children}
    </>
  );
  const cardClass = cn(
    "block w-[360px] max-w-full rounded-md border border-line bg-surface px-4 py-3 text-left transition-colors",
    href !== undefined && "hover:border-line-strong",
    className
  );
  if (href !== undefined) {
    return (
      <Link href={href} className={cardClass}>
        {body}
      </Link>
    );
  }
  return <div className={cardClass}>{body}</div>;
}

export function MissingNodeCard({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cn(
        "w-[360px] max-w-full rounded-md border border-dashed border-line bg-transparent px-4 py-3 text-left",
        className
      )}
    >
      <div className="mb-1 text-[0.6rem] font-semibold tracking-[0.09em] text-ink-3 uppercase">
        {label}
      </div>
      <span className="font-mono text-[0.78rem] text-ink-3">not yet synced</span>
    </div>
  );
}

export function Connector({ className }: { className?: string }) {
  return <div aria-hidden className={cn("h-5 w-px bg-line", className)} />;
}

export function Rail({ className }: { className?: string }) {
  return <div aria-hidden className={cn("h-px w-2/3 bg-line", className)} />;
}
