"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect } from "react";
import { useAnnounce } from "@/lib/hooks/use-announce";
import { cn } from "@/lib/utils";

/**
 * Table footer pager (spec §2.5).
 *
 * Layout: "Showing X–Y of N" | Rows [select] | prev [pages…] next
 *
 * Numbered pages use the mock's algorithm: `{1, page-1, page, page+1, last}`, deduplicated,
 * sorted, with an ellipsis inserted between any two adjacent numbers with a gap > 1.
 * That gives `1 … 4 5 6 … 20` on a large set, `1 2 3` on a small one.
 *
 * Buttons are real `<button>`s (keyboard accessible; prev/next `disabled` at bounds); the
 * page-size select is a real `<select>` so the browser handles keyboard/screen-reader
 * behavior for free (spec §2 explicitly favours native select here).
 */

export interface TablePagerProps {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly onPageChange: (page: number) => void;
  readonly onPageSizeChange: (size: number) => void;
  readonly className?: string;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200, 500] as const;

/** Build the numbered-page sequence with ellipsis markers. Exported for tests. */
export function computePagerSequence(
  page: number,
  totalPages: number
): ReadonlyArray<number | "ellipsis"> {
  if (totalPages <= 1) return [1];
  const around = Array.from(
    new Set([1, totalPages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= totalPages))
  ).sort((a, b) => a - b);
  const sequence: Array<number | "ellipsis"> = [];
  let last = 0;
  for (const p of around) {
    if (p - last > 1) sequence.push("ellipsis");
    sequence.push(p);
    last = p;
  }
  return sequence;
}

export function TablePager({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  className,
}: TablePagerProps) {
  const safeTotalPages = Math.max(1, totalPages);
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const sequence = computePagerSequence(page, safeTotalPages);

  /* Table settle → one polite announcement (FR-DM-091). The pager re-renders
     with new numbers whenever a filter, sort, page or page-size change lands,
     so announcing the RANGE here covers every data table with one wire. No
     first-render skip: react-query drops `data` while a new key fetches, so
     the pager REMOUNTS on every settle and a mount-skip would silence it for
     ever — the provider deduplicates repeats instead. */
  const announce = useAnnounce();
  const range = total === 0 ? "0 results" : `Showing ${start}–${end} of ${total}`;
  useEffect(() => {
    announce(range);
  }, [announce, range]);

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex items-center gap-3.5 border-t border-line-2 bg-surface-2 px-4 py-2 text-[0.74rem] text-ink-3",
        className
      )}
    >
      <span className="font-mono text-[0.72rem]">
        {total === 0 ? (
          <>
            <b className="font-semibold text-ink">0</b> results
          </>
        ) : (
          <>
            Showing{" "}
            <b className="font-semibold text-ink">
              {start}–{end}
            </b>{" "}
            of <b className="font-semibold text-ink">{total}</b>
          </>
        )}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-2">
          <span>Rows</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number.parseInt(event.target.value, 10))}
            aria-label="Rows per page"
            className="cursor-pointer rounded-sm border border-input bg-surface px-1.5 py-0.5 text-[0.74rem] font-semibold text-ink-2 outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-ring/40"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
            className="grid size-[26px] place-items-center rounded-sm border border-line bg-surface font-mono text-[0.72rem] text-ink-2 disabled:cursor-default disabled:opacity-35"
          >
            <ChevronLeftIcon aria-hidden className="size-3" />
          </button>
          {sequence.map((entry, index) =>
            entry === "ellipsis" ? (
              <span
                key={`ellipsis-${index}`}
                aria-hidden
                className="px-0.5 font-mono text-[0.72rem] text-ink-3"
              >
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                onClick={() => onPageChange(entry)}
                aria-label={`Page ${entry}`}
                aria-current={entry === page ? "page" : undefined}
                className={cn(
                  "grid h-[26px] min-w-[26px] place-items-center rounded-sm border border-transparent font-mono text-[0.72rem]",
                  entry === page
                    ? "bg-ink font-semibold text-bg dark:bg-accent-fill dark:text-accent-ink"
                    : "text-ink-2 hover:border-line hover:bg-surface"
                )}
              >
                {entry}
              </button>
            )
          )}
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= safeTotalPages}
            aria-label="Next page"
            className="grid size-[26px] place-items-center rounded-sm border border-line bg-surface font-mono text-[0.72rem] text-ink-2 disabled:cursor-default disabled:opacity-35"
          >
            <ChevronRightIcon aria-hidden className="size-3" />
          </button>
        </div>
      </div>
    </nav>
  );
}
