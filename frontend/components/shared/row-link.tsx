"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * A table row that navigates — the one row-activation pattern for every
 * clickable table (FR-DM-090).
 *
 * The row keeps its `row` role, so the table stays a table: a screen reader
 * still associates every cell with its column header. The real link sits in
 * the FIRST cell (RowLinkLabel wraps the row's id there) and carries the
 * keyboard and the screen-reader contract — Tab reaches it, Enter and Space
 * activate it, and its accessible name is the row's id. The row keeps its own
 * click handler, so a mouse user can still hit any part of the row.
 *
 * The row itself takes no role, no tabIndex and no key handler. The old
 * `role="link"` on the `<tr>` replaced the row role, which turned every table
 * into a list of long links and detached the column headers from the cells.
 *
 * `variant="styled"` renders the shadcn TableRow (runs table and friends);
 * `variant="plain"` renders a bare `<tr>` for the hand-rolled tables whose
 * cells globals.css styles — the caller passes its own row class.
 *
 * files-screen.tsx ships the same shape by hand (its rows hold a focusable
 * DownloadButton, so it wires the anchor itself).
 */
const RowHrefContext = createContext<string | null>(null);

interface RowLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  variant?: "styled" | "plain";
}

export function RowLink({ href, children, className, variant = "styled" }: RowLinkProps) {
  const router = useRouter();
  const handleClick = (event: MouseEvent<HTMLTableRowElement>) => {
    // A click that lands on a real control acts for that control only. This
    // also covers the RowLinkLabel anchor itself, so a click on the id never
    // navigates twice.
    if ((event.target as HTMLElement).closest("a,button,input,select,textarea")) return;
    router.push(href);
  };

  if (variant === "plain") {
    return (
      <RowHrefContext.Provider value={href}>
        <tr onClick={handleClick} className={className}>
          {children}
        </tr>
      </RowHrefContext.Provider>
    );
  }
  return (
    <RowHrefContext.Provider value={href}>
      <TableRow
        onClick={handleClick}
        className={cn(
          "cursor-pointer hover:bg-surface-2 focus-within:bg-surface-2",
          className
        )}
      >
        {children}
      </TableRow>
    </RowHrefContext.Provider>
  );
}

/**
 * The row's one real link. Wrap the id in the first cell with it.
 *
 * Pass `label` when the visible text alone does not name the target — two rows
 * can carry one name, and only the row's other cells tell them apart. It sets
 * the anchor's `aria-label`, so the whole phrase reaches a screen reader as
 * one accessible name.
 */
export function RowLinkLabel({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const href = useContext(RowHrefContext);
  // Outside a RowLink the label is just its content — a cell rendered in a
  // plain row (loading, reuse in another table) must not invent a dead link.
  if (href === null) return <>{children}</>;
  return (
    <Link
      href={href}
      aria-label={label}
      className={cn(
        "rounded-sm text-inherit no-underline outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {children}
    </Link>
  );
}
