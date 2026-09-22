import type { ExploreColumn } from "@/types";

/**
 * RFC 4180 CSV escaping: a field containing a comma, a double quote, or a
 * line break is wrapped in double quotes, with inner quotes doubled.
 * Null/undefined cells export as empty fields (the UI renders them as "—",
 * but the CSV carries the raw absence, never a placeholder glyph).
 */
export function escapeCsvField(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/** Build the full CSV document (header row + data rows, CRLF line endings). */
export function toCsv(columns: ExploreColumn[], rows: (string | null)[][]): string {
  const header = columns.map((column) => escapeCsvField(column.name)).join(",");
  const body = rows.map((row) => row.map(escapeCsvField).join(","));
  return [header, ...body].join("\r\n") + "\r\n";
}
