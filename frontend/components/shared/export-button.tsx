"use client";

import { useState } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError, buildQuery, type QueryParams } from "@/lib/api/client";
import { fetchDownload, triggerBrowserDownload } from "@/lib/api/download";
import {
  setExportColumns,
  useExportColumns,
  type ExportColumnScope,
} from "@/lib/export-columns";
import {
  chooseColumns,
  csvFilename,
  listToCsv,
  saveCsv,
  type CsvColumn,
} from "@/lib/table-csv";
import { saveXlsx, xlsxFilename } from "@/lib/table-xlsx";
import { cn } from "@/lib/utils";
import type { Paginated } from "@/types";

/**
 * The page size the export asks for. 500 is the largest value the API allows
 * (`ALLOWED_PAGE_SIZES` in `api/api/models/common.py`).
 */
const EXPORT_PAGE_SIZE = 500;

/**
 * The cap on the loop. The export reads 20 pages of 500 rows, so it stops at
 * 10,000 rows. The largest list in the demo is the signal catalog at 6,412
 * rows, so a whole list still fits. A broken filter cannot fetch for ever,
 * and a capped export says so in the toast.
 */
const MAX_EXPORT_PAGES = 20;

/**
 * The largest list the browser loop can carry whole: 20 pages of 500 rows.
 * Above it the browser file is a prefix, and only the server route answers
 * the whole set.
 */
const BROWSER_ROW_LIMIT = EXPORT_PAGE_SIZE * MAX_EXPORT_PAGES;

/** The three files the button writes. `server` comes from the API route. */
type ExportFormat = "csv" | "xlsx" | "server";

interface ExportButtonProps<T> {
  /** How many rows the filtered list holds. It disables the empty case. */
  readonly total: number;
  /** Read one page of the filtered list. The screen sets its own filters. */
  readonly fetchPage: (page: number, pageSize: number) => Promise<Paginated<T>>;
  /** Every column the screen offers, in the order the file carries them. */
  readonly columns: readonly CsvColumn<T>[];
  /** The list this button exports, in plural, e.g. "files". It names the file. */
  readonly list: string;
  /** The screen that owns the column choice. One `localStorage` key each. */
  readonly scope: ExportColumnScope;
  /**
   * The server-side export of this list (FR-DM-043) — its API path below
   * `/api/v1`, and the same filters object the list call carries.
   *
   * The route streams the WHOLE matching set, so it is the only export that
   * can answer a list above `BROWSER_ROW_LIMIT`, and it is the one a program
   * can schedule. `page` and `page_size` drop on the way: the export carries
   * no page.
   *
   * Absent, the button behaves exactly as it did before this prop existed.
   */
  readonly serverExport?: { readonly path: string; readonly params: QueryParams };
  readonly className?: string;
}

/**
 * Export the whole filtered list as CSV or as Excel (FR-DM-018).
 *
 * The button walks the list route page by page with the filters the screen
 * shows, joins the rows, and writes one document. Both writers stay in the
 * browser, so no new route answers this click.
 *
 * One code path decides the rows. The paging loop, the cap and the toast run
 * one time for both formats, and only the writer branches, so the CSV and the
 * Excel file always carry the same rows and the same columns.
 *
 * Which columns the file carries is chosen beside these buttons in the wide
 * form, and inside the menu in the compact one. Both write one store, so the
 * two forms always agree. A person who chooses nothing gets every column, so
 * the file is never empty.
 */
export function ExportButton<T>({
  total,
  fetchPage,
  columns,
  list,
  scope,
  serverExport,
  className,
}: ExportButtonProps<T>) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [fetched, setFetched] = useState(0);
  const chosen = useExportColumns(scope);
  const active = chooseColumns(columns, chosen);
  const empty = total === 0;

  const chooseHeaders = (next: readonly string[]) => {
    // Store the choice in the declared order of the screen, so the menu, the
    // store and the file all read the same way. An empty choice stays empty
    // here; `chooseColumns` is what turns it into the whole set later.
    const wanted = new Set(next);
    setExportColumns(
      scope,
      columns
        .filter((column) => wanted.has(column.header))
        .map((column) => column.header),
    );
  };

  /**
   * Ask the API for the file, and hand the bytes to the browser.
   *
   * The route takes the same filters the list call takes, so the file holds
   * the rows the screen shows — every one of them, not the pages the loop
   * walked. `fetchDownload` is the path the file download already uses, so
   * the viewer's own token names the person in the audit row.
   */
  const exportFromServer = async () => {
    if (serverExport === undefined) return;
    setBusy("server");
    setFetched(0);
    try {
      // The export carries no page. Every other filter travels unchanged, and
      // it travels through the one query builder the list call uses.
      const { page: _page, page_size: _pageSize, ...filters } = serverExport.params;
      const query = buildQuery({
        ...filters,
        // An empty choice asks for every column, which is what the route does
        // with no `columns` at all.
        columns: chosen.length > 0 ? [...chosen] : undefined,
      });
      const outcome = await fetchDownload(
        `${serverExport.path}${query}`,
        csvFilename(list),
      );
      triggerBrowserDownload(outcome.blob, outcome.filename);
      toast.success(`Exported ${total} ${list}`, {
        description: `${outcome.filename} — the whole filtered list, written by the server.`,
      });
    } catch (error) {
      // The route states why it refused: `export_too_large` names the cap.
      // Never replace that sentence with a generic one.
      toast.error(`The ${list} export failed`, {
        description:
          error instanceof ApiError ? error.detail : "The server did not answer. Try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const exportRows = async (format: ExportFormat) => {
    setBusy(format);
    setFetched(0);
    try {
      const rows: T[] = [];
      let totalPages = 1;
      let listTotal = 0;
      let page = 1;
      while (page <= Math.min(totalPages, MAX_EXPORT_PAGES)) {
        const answer = await fetchPage(page, EXPORT_PAGE_SIZE);
        rows.push(...answer.items);
        totalPages = answer.total_pages;
        listTotal = answer.total;
        setFetched(rows.length);
        page += 1;
      }

      // The only branch: the same rows and the same columns, two writers.
      let filename: string;
      if (format === "csv") {
        filename = csvFilename(list);
        saveCsv(filename, listToCsv(active, rows));
      } else {
        filename = xlsxFilename(list);
        await saveXlsx(filename, active, rows);
      }

      if (totalPages > MAX_EXPORT_PAGES) {
        // Never call a partial file complete.
        toast.warning(
          `Exported the first ${rows.length} of ${listTotal} ${list}`,
          {
            description: `${filename} — the export stops at ${MAX_EXPORT_PAGES} pages, so this file is not complete. Add a filter to get the rest.`,
          },
        );
      } else {
        toast.success(`Exported ${rows.length} ${list}`, {
          description: `${filename} — the whole filtered list, with the filters you set.`,
        });
      }
    } catch {
      toast.error(`The ${list} export failed`, {
        description: "The list did not answer. Try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const running = busy !== null;

  return (
    <div className={cn("inline-flex flex-none items-center", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={empty || running}
          // The disabled reason belongs in the name, exactly as it does on
          // the wide buttons. A `title` alone never reaches a keyboard or a
          // screen-reader user (FR-DM-091).
          aria-label={
            running
              ? `Exporting ${list}, ${fetched} rows so far`
              : empty
                ? `Export ${list} — the filtered list holds no row`
                : `Export all ${total} ${list}`
          }
          aria-busy={running}
          className={cn(
            "inline-flex flex-none items-center gap-[6px] rounded-md border border-border bg-surface px-[11px] py-[5px] text-[0.76rem] font-semibold text-ink-2 transition-colors",
            "hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {running ? (
            <Loader2 className="size-[13px] animate-spin" strokeWidth={2.2} />
          ) : (
            <Download className="size-[13px]" strokeWidth={2.2} />
          )}
          {running
            ? fetched > 0
              ? `Exporting… ${fetched}`
              : "Exporting…"
            : "Export"}
          <ChevronDown className="size-[12px] opacity-60" strokeWidth={2.2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-[70vh] min-w-56 overflow-y-auto"
        >
          {/* Two groups, and each heading says WHERE the file is written and
              HOW MUCH it carries. Both used to sit under one unnamed group,
              and two items that both read "Export" tell a presenter nothing.
              The item labels stay short — the heading carries the difference. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>In this browser</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => void exportRows("csv")}>
              <Download className="size-[13px]" strokeWidth={2.2} />
              CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportRows("xlsx")}>
              <Download className="size-[13px]" strokeWidth={2.2} />
              Excel
            </DropdownMenuItem>
            {/* Never let a person take a prefix believing it is the list. The
                browser loop stops at `BROWSER_ROW_LIMIT` rows, and this list
                is longer, so say so where the choice is made. */}
            {total > BROWSER_ROW_LIMIT && (
              <div className="px-2 pb-1 text-[0.68rem] leading-snug text-ink-3">
                {`Stops at ${BROWSER_ROW_LIMIT} of ${total} ${list}.`}
              </div>
            )}
          </DropdownMenuGroup>

          {/* The server route (FR-DM-043). It streams the whole matching set,
              so it is the only item that answers a list above
              `BROWSER_ROW_LIMIT`, and it is the one a program can schedule.
              The browser items above keep working exactly as before. */}
          {serverExport !== undefined && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>From the server</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => void exportFromServer()}>
                  <Download className="size-[13px]" strokeWidth={2.2} />
                  CSV — every matching row
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}

          <DropdownMenuSeparator />

          {/* The column choice sits inside this menu because it changes the
                FILE and nothing else. Named "Columns" out in a toolbar it read
                as the table's columns, and an empty picker beside a full table
                reads as broken. Here it is unmistakably part of the export.
                The heading states the empty rule, because `chooseColumns`
                treats "none ticked" as "write every column". */}
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-baseline justify-between gap-3">
              <span>Columns in the file</span>
              <span className="font-mono text-[0.68rem] font-normal text-ink-3">
                {chosen.length === 0
                  ? `all ${columns.length}`
                  : `${chosen.length}/${columns.length}`}
              </span>
            </DropdownMenuLabel>
            {columns.map((column) => {
              const picked = chosen.includes(column.header);
              return (
                <DropdownMenuCheckboxItem
                  key={column.header}
                  checked={picked}
                  // Choosing columns is a multi-step act, so the menu stays
                  // open across ticks. Without this the first tick closes it
                  // and the second needs the menu opened again.
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() =>
                    chooseHeaders(
                      picked
                        ? chosen.filter((header) => header !== column.header)
                        : [...chosen, column.header],
                    )
                  }
                  // Hide the primitive's trailing tick. It draws a check when
                  // ticked and NOTHING when clear, so an unticked row looked
                  // like plain text and gave a reader no sign it could be
                  // ticked at all. The box below is drawn in both states.
                  className="gap-2.5 pr-2 pl-2 [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
                >
                  {/* The same `Checkbox` the filter popovers use, so a tick
                        looks identical wherever it appears. It is decoration:
                        the row itself is the `menuitemcheckbox` and carries
                        `aria-checked`, so this must not be focusable, clickable
                        or announced a second time. */}
                  <Checkbox
                    checked={picked}
                    aria-hidden="true"
                    tabIndex={-1}
                    className="pointer-events-none"
                  />
                  {column.header}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
