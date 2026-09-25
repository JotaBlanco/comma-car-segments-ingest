"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { TableScrollArea } from "@/components/shared/panel";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { ToneBadge } from "@/components/shared/status-badge";
import { TablePager } from "@/components/shared/table-pager";
import { formatRate } from "@/lib/format";
import type { FileSignal } from "@/types";
import { formatStat } from "./format";

const ROW_CLASS =
  "cursor-pointer transition-colors hover:bg-surface-2 focus-within:bg-surface-2";

// The API answers stats: null until the lake holds the samples. Show a dash, never a zero.
const NO_STAT = "—";

const stat = (value: number | undefined) => (value === undefined ? NO_STAT : formatStat(value));

// 20 rows fit one screen. The run signals tab uses the same default, so the
// two signal tables page alike. The Rows select still offers the larger
// sizes from the API's allow-list.
const DEFAULT_PAGE_SIZE = 20;

interface FileSignalsTableProps {
  signals: FileSignal[];
  signalCount: number;
  /**
   * True when the file's status is quarantined. The empty state used to claim
   * a quarantine for EVERY empty list, so a registered file that simply
   * carried no per-signal metadata read as quarantined. The claim now follows
   * the status.
   */
  quarantined?: boolean;
}

export function FileSignalsTable({ signals, signalCount, quarantined = false }: FileSignalsTableProps) {
  /* The file route is not paged — the detail response embeds the signals, so
     the client holds the set and pages it here. The table used to render all
     of them in one block, which ran to 261 rows. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  /* Clamp, never trust the state. The component stays mounted across a file
     change, so a page picked on a long file could point past a short one. */
  const totalPages = Math.max(1, Math.ceil(signals.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = signals.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <>
      {/* The page scrolls, so the sticky opt-in needs its own bounded scroll
          region — `position: sticky` does nothing without one. The cap keeps
          the region on screen; the pager sits OUTSIDE it, so a person never
          scrolls a page of rows to reach it. */}
      <TableScrollArea className="max-h-[max(20rem,70dvh)]">
      <table aria-label="Signals of this file" className="w-full">
        <thead>
          <tr>
            <th scope="col">Signal</th>
            <th scope="col">Unit</th>
            <th scope="col" className="text-right!">Rate</th>
            <th scope="col" className="text-right!">Min</th>
            <th scope="col" className="text-right!">Max</th>
            <th scope="col" className="text-right!">Mean</th>
          </tr>
        </thead>
        <tbody>
          {signals.length === 0 && (
            <tr>
              <td colSpan={6}>
                <EmptyState
                  title="No signals cataloged"
                  message={
                    quarantined
                      ? "File was quarantined before header parsing — nothing cataloged."
                      : "The registration carried no per-signal metadata for this file."
                  }
                />
              </td>
            </tr>
          )}
          {pageRows.map((signal) => (
            <RowLink
              key={signal.name}
              variant="plain"
              href={`/signals/${encodeURIComponent(signal.name)}`}
              className={ROW_CLASS}
            >
              <td>
                <RowLinkLabel>
                  <span className="font-mono text-[0.78rem]">{signal.name}</span>
                </RowLinkLabel>
              </td>
              <td>
                {signal.unit !== null ? (
                  <span className="font-mono text-[0.78rem]">{signal.unit}</span>
                ) : (
                  <ToneBadge tone="amber" dot>
                    missing
                  </ToneBadge>
                )}
              </td>
              <td className="text-right font-mono text-[0.78rem]">{formatRate(signal.rate_hz)} Hz</td>
              <td className="text-right font-mono text-[0.78rem]">{stat(signal.stats?.min)}</td>
              <td className="text-right font-mono text-[0.78rem]">{stat(signal.stats?.max)}</td>
              <td className="text-right font-mono text-[0.78rem]">{stat(signal.stats?.mean)}</td>
            </RowLink>
          ))}
          {signals.length > 0 && (
            <tr>
              <td colSpan={6} className="text-center text-[0.74rem] text-ink-3">
                Per-signal values from the file registration — no file download.{" "}
                {/* The fetch caps the embedded set. When the file registers
                    more, say so — the pager below counts the fetched rows,
                    and it must never claim rows the client does not hold. */}
                {signalCount > signals.length &&
                  `The file registers ${signalCount} signals and this table holds the first ${signals.length}. `}
                <Link href="/signals" className="text-[0.75rem] font-semibold text-primary">
                  Open the signal catalog
                </Link>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </TableScrollArea>
      {signals.length > 0 && (
        <TablePager
          page={safePage}
          pageSize={pageSize}
          total={signals.length}
          totalPages={totalPages}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      )}
    </>
  );
}
