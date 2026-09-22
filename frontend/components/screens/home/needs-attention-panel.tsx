"use client";

import { Ban, Flag, TriangleAlert, Unlink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Panel, PanelHead } from "@/components/shared/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { entityHref } from "@/lib/journal-href";
import { cn } from "@/lib/utils";
import type { AttentionRows, NeedsAttention } from "@/types";

/**
 * How many rows the panel prints per category. The API sends the same cap,
 * and the slice here holds even if a later API sends more: the panel sits in
 * the narrow right column, and four categories of three rows is its budget.
 * The count in the category head is always the true total, and the line
 * under the rows says how many the cap holds back.
 */
const MAX_ROWS = 3;

interface AttentionCategoryProps {
  href: string;
  tone: "amber" | "red";
  icon: ReactNode;
  title: string;
  sub: string;
  count: number;
  children?: ReactNode;
}

/** The category head: one link to the filtered list, with the true total. */
function AttentionCategory({
  href,
  tone,
  icon,
  title,
  sub,
  count,
  children,
}: AttentionCategoryProps) {
  return (
    <div className="border-b border-line-2 last:border-b-0">
      <Link
        href={href}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-surface-2"
      >
        <span
          className={cn(
            "grid size-[26px] flex-none place-items-center rounded-[5px]",
            tone === "amber" ? "bg-amber-bg text-amber" : "bg-red-bg text-red"
          )}
        >
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-[0.8rem] font-semibold">{title}</span>
          <span className="block text-[0.72rem] text-ink-3">{sub}</span>
        </span>
        <span className="ml-auto font-mono text-[0.8rem] font-semibold text-ink-2">{count}</span>
      </Link>
      {children}
    </div>
  );
}

/** One row the panel can print: where it links, its id line, its context. */
interface NamedRow {
  key: string;
  href: string;
  id: string;
  sub: string | null;
}

/**
 * The named entities under one category head, and the hidden-count line.
 *
 * The column is narrow, so a long id may wrap anywhere (`break-all` — an id
 * has no spaces) and a long reason wraps at words. Nothing here may force a
 * sideways scrollbar. This is a plain list on purpose: `TableCell` carries
 * `whitespace-nowrap`, and that is the exact trap.
 */
function CategoryRows({
  rows,
  count,
  moreHref,
}: {
  rows: NamedRow[];
  count: number;
  moreHref: string;
}) {
  const shown = rows.slice(0, MAX_ROWS);
  const hidden = Math.max(0, count - shown.length);
  return (
    <div className="pb-2">
      {shown.map((row) => (
        <Link
          key={row.key}
          href={row.href}
          className="block py-1 pr-4 pl-[52px] transition-colors hover:bg-surface-2"
        >
          <span className="block font-mono text-[0.75rem] break-all text-ink-2">{row.id}</span>
          {row.sub !== null && row.sub !== "" && (
            <span className="block text-[0.7rem] break-words text-ink-3">{row.sub}</span>
          )}
        </Link>
      ))}
      {hidden > 0 && (
        <Link
          href={moreHref}
          className="block py-1 pr-4 pl-[52px] text-[0.7rem] font-semibold text-primary hover:underline"
        >
          {hidden} more — view all
        </Link>
      )}
    </div>
  );
}

interface NeedsAttentionPanelProps {
  attention: NeedsAttention | undefined;
  /** The named entities behind the counts. An API older than 26 Aug 2026
      sends none — the panel then shows the counts alone, as it always did. */
  rows?: AttentionRows;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
}

export function NeedsAttentionPanel({
  attention,
  rows,
  isPending,
  isError,
  onRetry,
}: NeedsAttentionPanelProps) {
  /* `orphaned_definitions` is optional — an API built before TR-001 omits it.
     `?? 0` keeps the sum a number: `undefined` in the addition would print
     "NaN items" in the head of this panel. */
  const total =
    attention !== undefined
      ? attention.awaiting_work_order +
        attention.quarantined_files +
        attention.invalid_runs +
        (attention.orphaned_definitions ?? 0)
      : 0;
  return (
    <Panel>
      <PanelHead
        title="Needs attention"
        action={
          attention !== undefined && (
            <span className="font-mono text-[0.68rem] text-ink-3">
              {total} {total === 1 ? "item" : "items"}
            </span>
          )
        }
      />
      {isPending && (
        <div className="space-y-3 px-4 py-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {isError && <ErrorState onRetry={onRetry} />}
      {attention !== undefined && (
        <>
          {attention.awaiting_work_order > 0 && (
            <AttentionCategory
              href="/runs?status=awaiting_work_order"
              tone="amber"
              icon={<TriangleAlert size={13} strokeWidth={2.4} />}
              title="Runs awaiting work order"
              sub="Data arrived, planning context not yet synced"
              count={attention.awaiting_work_order}
            >
              {rows !== undefined && (
                <CategoryRows
                  rows={rows.awaiting_work_order.map((row) => ({
                    key: row.run_id,
                    href: entityHref("run", row.run_id),
                    id: row.run_id,
                    sub: row.rig_id,
                  }))}
                  count={attention.awaiting_work_order}
                  moreHref="/runs?status=awaiting_work_order"
                />
              )}
            </AttentionCategory>
          )}
          {attention.quarantined_files > 0 && (
            <AttentionCategory
              href="/files?status=quarantined"
              tone="red"
              icon={<Ban size={13} strokeWidth={2.4} />}
              title="Quarantined files"
              sub="Checksum or format validation failed"
              count={attention.quarantined_files}
            >
              {rows !== undefined && (
                <CategoryRows
                  rows={rows.quarantined_files.map((row) => ({
                    key: row.file_id,
                    href: entityHref("file", row.file_id),
                    // The filename is what a person recognises. A file the
                    // registry stored without one still shows its id.
                    id: row.filename ?? row.file_id,
                    sub: row.quarantine_reason,
                  }))}
                  count={attention.quarantined_files}
                  moreHref="/files?status=quarantined"
                />
              )}
            </AttentionCategory>
          )}
          {attention.invalid_runs > 0 && (
            <AttentionCategory
              href="/runs?status=invalid"
              tone="red"
              icon={<Flag size={13} strokeWidth={2.4} />}
              title="Invalid-flagged runs"
              sub="Flagged by an engineer with reason"
              count={attention.invalid_runs}
            >
              {rows !== undefined && (
                <CategoryRows
                  rows={rows.invalid_runs.map((row) => ({
                    key: row.run_id,
                    href: entityHref("run", row.run_id),
                    id: row.run_id,
                    sub: row.reason,
                  }))}
                  count={attention.invalid_runs}
                  moreHref="/runs?status=invalid"
                />
              )}
            </AttentionCategory>
          )}
          {(attention.orphaned_definitions ?? 0) > 0 && (
            <AttentionCategory
              href="/definitions?orphaned=true"
              tone="amber"
              icon={<Unlink size={13} strokeWidth={2.4} />}
              title="Orphaned test definitions"
              sub="No work order links this definition"
              count={attention.orphaned_definitions ?? 0}
            >
              {rows !== undefined && (
                <CategoryRows
                  rows={rows.orphaned_definitions.map((row) => ({
                    key: row.td_id,
                    href: entityHref("test_definition", row.td_id),
                    id: row.td_id,
                    sub: row.title,
                  }))}
                  count={attention.orphaned_definitions ?? 0}
                  moreHref="/definitions?orphaned=true"
                />
              )}
            </AttentionCategory>
          )}
          {total === 0 && <EmptyState message="Nothing needs attention." />}
        </>
      )}
    </Panel>
  );
}
