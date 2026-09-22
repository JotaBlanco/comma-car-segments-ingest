/**
 * Excel export of a list screen (FR-DM-018, UC-004).
 *
 * The rows and the columns arrive already decided. `ExportButton` runs the
 * paging loop one time and hands the same rows and the same chosen columns to
 * this writer or to the CSV writer, so the two files always agree.
 *
 * The writer is `write-excel-file` (4.1.1), pure JavaScript over `fflate`.
 * It builds the ZIP and the SpreadsheetML parts, so we own no CRC32, no
 * central directory and no `[Content_Types].xml`. The `/browser` export
 * returns a `Blob`, and the same hidden anchor saves it.
 *
 * A column declares its kind in `CsvColumn.type`. The writer turns a number
 * column into a numeric cell and a date column into a date cell, so a count
 * sums and a timestamp sorts in Excel. A value that does not parse falls back
 * to text, because a wrong number is worse than a string.
 */

import writeXlsxFile, { type Cell, type SheetData } from "write-excel-file/browser";
import { exportFilename, saveBlob } from "@/lib/save-blob";
import type { CsvColumn } from "@/lib/table-csv";

/** The number format of every date cell. It sorts and it reads. */
export const XLSX_DATE_FORMAT = "yyyy-mm-dd hh:mm:ss";

/** The one sheet the export writes. */
const SHEET_NAME = "Export";

/** Turn one raw value into one typed Excel cell. */
function toCell(raw: string | number | null | undefined, type: CsvColumn<never>["type"]): Cell {
  // An absent value stays an empty cell. The screen prints "—" for it, and
  // that glyph must never reach a spreadsheet.
  if (raw === null || raw === undefined || raw === "") return null;

  if (type === "number") {
    const number = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(number)) return { value: number, type: Number };
  }

  if (type === "date") {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return { value: date, type: Date, format: XLSX_DATE_FORMAT };
    }
  }

  return { value: String(raw), type: String };
}

/** Build the sheet: the header row first, then one row per item. */
export function listToSheetData<T>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
): SheetData {
  const header = columns.map((column) => ({ value: column.header, type: String }) as Cell);
  const body = rows.map((row) => columns.map((column) => toCell(column.value(row), column.type)));
  return [header, ...body];
}

/** Build the `.xlsx` document of a list. */
export function listToXlsxBlob<T>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
): Promise<Blob> {
  return writeXlsxFile(listToSheetData(columns, rows), { sheet: SHEET_NAME }).toBlob();
}

/** The name of the saved file, e.g. `test-runs-2026-08-21.xlsx`. */
export function xlsxFilename(list: string, at: Date = new Date()): string {
  return exportFilename(list, "xlsx", at);
}

/** Hand an Excel document to the browser's download. */
export async function saveXlsx<T>(
  filename: string,
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
): Promise<void> {
  saveBlob(filename, await listToXlsxBlob(columns, rows));
}
