/**
 * The chosen-column rule of the export (FR-DM-018, picker half).
 *
 * The rule the whole feature rests on: the file carries the columns in the
 * order the screen declares them, and a person who chooses nothing gets
 * every column.
 *
 * Config: `vitest.unit.config.ts` takes `tests/unit/**`.
 */
import { describe, expect, it } from "vitest";
import { chooseColumns, listToCsv, type CsvColumn } from "@/lib/table-csv";

interface Row {
  name: string;
  unit: string | null;
  runs: number;
}

const COLUMNS: readonly CsvColumn<Row>[] = [
  { header: "Signal", value: (row) => row.name },
  { header: "Unit", value: (row) => row.unit },
  { header: "Runs", value: (row) => row.runs, type: "number" },
];

const ROWS: readonly Row[] = [{ name: "batt_temp", unit: "degC", runs: 12 }];

function headers<T>(columns: readonly CsvColumn<T>[]): string[] {
  return columns.map((column) => column.header);
}

describe("chooseColumns", () => {
  it("keeps every column when a person chooses nothing", () => {
    expect(headers(chooseColumns(COLUMNS, []))).toEqual(["Signal", "Unit", "Runs"]);
  });

  it("keeps every column when the choice names no known column", () => {
    // A stale entry in `localStorage` after a screen drops a column.
    expect(headers(chooseColumns(COLUMNS, ["Gone", "Older"]))).toEqual([
      "Signal",
      "Unit",
      "Runs",
    ]);
  });

  it("keeps only the chosen columns", () => {
    expect(headers(chooseColumns(COLUMNS, ["Runs", "Signal"]))).toEqual(["Signal", "Runs"]);
  });

  it("keeps the declared order, never the order a person clicked", () => {
    // "Runs" comes last in the constant, so it comes last in the file.
    expect(headers(chooseColumns(COLUMNS, ["Runs", "Unit", "Signal"]))).toEqual([
      "Signal",
      "Unit",
      "Runs",
    ]);
  });

  it("drops a column the choice does not name", () => {
    expect(headers(chooseColumns(COLUMNS, ["Signal"]))).toEqual(["Signal"]);
  });
});

describe("the chosen columns reach the CSV", () => {
  it("writes the chosen headers in the declared order", () => {
    const csv = listToCsv(chooseColumns(COLUMNS, ["Runs", "Signal"]), ROWS);

    expect(csv).toBe("Signal,Runs\r\nbatt_temp,12\r\n");
    expect(csv).not.toContain("Unit");
  });

  it("never writes an empty file for an empty choice", () => {
    const csv = listToCsv(chooseColumns(COLUMNS, []), ROWS);

    expect(csv).toBe("Signal,Unit,Runs\r\nbatt_temp,degC,12\r\n");
  });
});
