/**
 * CSV export of a list screen (FR-DM-018, UC-004).
 *
 * The export stays in the browser. The screen already holds the rows it
 * shows, so the helper turns those rows into a document and hands it to the
 * browser's own download. No route, no round trip and no journal entry.
 *
 * `toCsv` (`lib/explore/csv.ts`) is the RFC 4180 writer the Explore tab
 * already uses. This module only adapts a list of objects to it: one header
 * and one accessor per column.
 *
 * A column also declares what kind of value it carries. The CSV writer
 * ignores that field and still writes the stored value as text, so the CSV
 * bytes stay the same. The Excel writer (`lib/table-xlsx.ts`) reads it and
 * types the cell, so a count sums and a timestamp sorts.
 */

import { toCsv } from "@/lib/explore/csv";
import { exportFilename, saveBlob } from "@/lib/save-blob";

/** What a column carries. A column that says nothing carries text. */
export type CsvColumnType = "text" | "number" | "date";

/** One column of the export: the header, and how to read one row. */
export interface CsvColumn<T> {
  readonly header: string;
  /** The raw value. A CSV carries the stored value, never a screen glyph. */
  readonly value: (row: T) => string | number | null | undefined;
  /** The kind of value. It types the Excel cell. It defaults to "text". */
  readonly type?: CsvColumnType;
}

/**
 * The columns the export writes, in the order the screen declares them.
 *
 * A person who chooses nothing gets every column, so the file is never empty.
 * A choice that names no known column also gets every column, which covers a
 * stale entry in `localStorage` after a screen drops a column.
 *
 * The order is always the declared order of the screen constant. The picker
 * lists the columns in that same order, so the order a person sees is the
 * order the file carries.
 */
export function chooseColumns<T>(
  columns: readonly CsvColumn<T>[],
  chosen: readonly string[],
): readonly CsvColumn<T>[] {
  if (chosen.length === 0) return columns;
  const wanted = new Set(chosen);
  const kept = columns.filter((column) => wanted.has(column.header));
  return kept.length > 0 ? kept : columns;
}

/** Build the CSV document of a list — header row first, CRLF line endings. */
export function listToCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  return toCsv(
    columns.map((column) => ({ name: column.header })),
    rows.map((row) =>
      columns.map((column) => {
        const cell = column.value(row);
        // An absent value stays an empty field. The screen prints "—" for it,
        // and that glyph must never reach a spreadsheet.
        return cell === null || cell === undefined ? null : String(cell);
      }),
    ),
  );
}

/** The name of the saved file, e.g. `test-runs-2026-08-21.csv`. */
export function csvFilename(list: string, at: Date = new Date()): string {
  return exportFilename(list, "csv", at);
}

/**
 * Hand a CSV document to the browser's download.
 *
 * The same hidden-anchor path the Explore tab uses. The blob URL lives on
 * this origin only, and the bytes never leave the browser.
 */
export function saveCsv(filename: string, csv: string): void {
  saveBlob(filename, new Blob([csv], { type: "text/csv;charset=utf-8" }));
}
