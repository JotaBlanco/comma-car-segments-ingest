"use client";

import Link from "next/link";
import { ErrorState } from "@/components/shared/error-state";
import { Panel, PanelHead } from "@/components/shared/panel";
import { SourceBadge } from "@/components/shared/source-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatInt } from "@/lib/format";
import type { SourceCount } from "@/types";

/**
 * Where the registry's metadata came from — TR-011.
 *
 * One row per source, counting tagged fields, not rows: a run whose operator
 * a person typed counts one manual field, not one manual run. The API serves
 * every source, even at zero, and this panel keeps that order, so the card
 * never reflows between two loads.
 *
 * Each row links to the runs list at that source, which is the same tag the
 * `source` filter of the four list routes reads.
 */

interface SourceBreakdownPanelProps {
  breakdown: readonly SourceCount[] | undefined;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
}

export function SourceBreakdownPanel({
  breakdown,
  isPending,
  isError,
  onRetry,
}: SourceBreakdownPanelProps) {
  const total = (breakdown ?? []).reduce((sum, row) => sum + row.field_count, 0);
  return (
    <Panel>
      <PanelHead
        title="Metadata by source"
        action={
          breakdown !== undefined && (
            <span className="font-mono text-[0.68rem] text-ink-3">
              {formatInt(total)} {total === 1 ? "field" : "fields"}
            </span>
          )
        }
      />
      {isPending && (
        <div className="space-y-3 px-4 py-3">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      )}
      {isError && <ErrorState onRetry={onRetry} />}
      {breakdown !== undefined &&
        breakdown.map((row) => (
          <Link
            key={row.source}
            href={`/runs?source=${encodeURIComponent(row.source)}`}
            className="flex w-full items-center gap-2.5 border-b border-line-2 px-4 py-2 transition-colors last:border-b-0 hover:bg-surface-2"
          >
            <SourceBadge source={row.source} />
            <span className="ml-auto font-mono text-[0.8rem] font-semibold text-ink-2">
              {formatInt(row.field_count)}
            </span>
          </Link>
        ))}
    </Panel>
  );
}
