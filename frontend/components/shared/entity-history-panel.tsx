"use client";

import type { ReactNode } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { JournalTimeline } from "@/components/shared/journal-timeline";
import { Panel, PanelHead } from "@/components/shared/panel";
import { QuickViewSegment } from "@/components/shared/quick-view-segment";
import { TablePager } from "@/components/shared/table-pager";
import { Skeleton } from "@/components/ui/skeleton";
import type { JournalEntry, JournalKind, Paginated } from "@/types";

/**
 * The query params of one entity journal read. Every journal route takes the
 * same three (`api/api/routers/journal.py`), so one shape serves the file, the
 * signal, the work order, the result and the definition alike.
 */
export interface JournalPanelParams {
  page?: number;
  page_size?: number;
  kind?: JournalKind;
}

/** The quick views of the kind filter. "all" sends no `kind` param at all. */
const KIND_VIEWS = [
  { id: "all", label: "All" },
  { id: "change", label: "Changes" },
  { id: "event", label: "Events" },
  { id: "note", label: "Notes" },
] as const;

/**
 * The journal kind filter — one segmented control over the server-side `kind`
 * param. The run detail's Journal tab renders it too, so the filter reads the
 * same way on every timeline.
 */
export function JournalKindFilter({
  kind,
  onKindChange,
  "aria-label": ariaLabel,
  className,
}: {
  kind: JournalKind | undefined;
  onKindChange: (kind: JournalKind | undefined) => void;
  "aria-label": string;
  className?: string;
}) {
  return (
    <QuickViewSegment
      views={KIND_VIEWS}
      activeId={kind ?? "all"}
      onSelect={(id) => onKindChange(id === "all" ? undefined : (id as JournalKind))}
      aria-label={ariaLabel}
      className={className}
    />
  );
}

/**
 * The history panel of one entity — contract §8b.
 *
 * The file, the signal, the work-order, the definition and the result screens
 * each read their own journal and show it here. The panel owns the frame, the
 * count, the kind filter, the pager and the two waiting states. The timeline
 * itself is `JournalTimeline`, the same component the run detail uses, so one
 * entry reads the same way on every screen.
 *
 * The caller passes the query result, so this file needs no hook of its own
 * and each screen keeps its own query key. The filter and the pager are
 * controlled the same way: the caller holds the params in state, feeds them
 * to its journal hook and hands `onParamsChange` down. Without
 * `onParamsChange` the panel renders the plain timeline, as it always did.
 */
interface EntityHistoryPanelProps {
  /** What the entity is called on this screen, for the empty state. */
  label: string;
  isPending: boolean;
  isError: boolean;
  page: Paginated<JournalEntry> | undefined;
  onRetry: () => void;
  className?: string;
  /** The params the caller's journal hook currently asks with. */
  params?: JournalPanelParams;
  /** Turns on the kind filter and the pager. The caller re-queries with it. */
  onParamsChange?: (params: JournalPanelParams) => void;
  /** Optional head action, e.g. the Add note button. */
  action?: ReactNode;
}

export function EntityHistoryPanel({
  label,
  isPending,
  isError,
  page,
  onRetry,
  className,
  params,
  onParamsChange,
  action,
}: EntityHistoryPanelProps) {
  const filtered = params?.kind !== undefined;
  return (
    <Panel className={className}>
      <PanelHead
        title="History"
        action={
          <span className="inline-flex items-center gap-2.5">
            {page !== undefined && page.total > 0 && (
              <span className="font-mono text-[0.68rem] text-ink-3">
                {page.total} {page.total === 1 ? "entry" : "entries"}
              </span>
            )}
            {action}
          </span>
        }
      />
      {onParamsChange !== undefined && (
        <div className="flex items-center border-b border-line-2 px-4 py-2">
          {/* A kind flip starts a fresh question, so it always reads page 1 —
              page 3 of "everything" says nothing about page 3 of the notes. */}
          <JournalKindFilter
            aria-label={`Filter the ${label} history by kind`}
            kind={params?.kind}
            onKindChange={(kind) => onParamsChange({ ...params, kind, page: 1 })}
          />
        </div>
      )}
      {isPending ? (
        <div className="space-y-4 p-5">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex gap-3.5">
              <Skeleton className="size-[22px] rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : isError || page === undefined ? (
        <ErrorState message={`Could not load the history of this ${label}.`} onRetry={onRetry} />
      ) : page.items.length === 0 && filtered ? (
        /* The unfiltered empty state says "nothing happened yet". Under a kind
           filter that sentence would lie — entries exist, just not this kind. */
        <div className="px-5 py-8 text-center text-[0.78rem] text-ink-3">
          No {params?.kind} entries in the history of this {label}.
        </div>
      ) : (
        <>
          <JournalTimeline entries={page.items} />
          {onParamsChange !== undefined && page.total > 0 && (
            <TablePager
              page={page.page}
              pageSize={page.page_size}
              total={page.total}
              totalPages={page.total_pages}
              onPageChange={(nextPage) => onParamsChange({ ...params, page: nextPage })}
              onPageSizeChange={(size) =>
                onParamsChange({ ...params, page_size: size, page: 1 })
              }
            />
          )}
        </>
      )}
    </Panel>
  );
}
