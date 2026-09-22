/**
 * The CSV export helper of the list screens (FR-DM-018).
 *
 * Config: `vitest.unit.config.ts` takes `tests/unit/**`.
 */
import { describe, expect, it } from "vitest";
import { csvFilename, listToCsv, type CsvColumn } from "@/lib/table-csv";

interface Row {
  name: string;
  unit: string | null;
  runs: number;
}

const COLUMNS: readonly CsvColumn<Row>[] = [
  { header: "Signal", value: (row) => row.name },
  { header: "Unit", value: (row) => row.unit },
  { header: "Runs", value: (row) => row.runs },
];

describe("listToCsv", () => {
  it("writes the header row first, then one row per item", () => {
    const csv = listToCsv(COLUMNS, [
      { name: "batt_temp", unit: "degC", runs: 12 },
      { name: "batt_soc", unit: "%", runs: 7 },
    ]);

    expect(csv).toBe("Signal,Unit,Runs\r\nbatt_temp,degC,12\r\nbatt_soc,%,7\r\n");
  });

  it("writes an empty field for an absent value, never a dash", () => {
    const csv = listToCsv(COLUMNS, [{ name: "batt_temp", unit: null, runs: 0 }]);

    expect(csv).toBe("Signal,Unit,Runs\r\nbatt_temp,,0\r\n");
    expect(csv).not.toContain("—");
  });

  it("quotes a field that holds a comma, a quote or a line break", () => {
    const csv = listToCsv(COLUMNS, [
      { name: 'pack, "A"', unit: "deg\nC", runs: 1 },
    ]);

    expect(csv).toBe('Signal,Unit,Runs\r\n"pack, ""A""","deg\nC",1\r\n');
  });

  it("writes the header row alone when the list holds no item", () => {
    expect(listToCsv(COLUMNS, [])).toBe("Signal,Unit,Runs\r\n");
  });
});

describe("csvFilename", () => {
  it("names the list and the day, and joins the words of the list", () => {
    const at = new Date("2026-08-21T15:04:05Z");

    expect(csvFilename("files", at)).toBe("files-2026-08-21.csv");
    expect(csvFilename("test runs", at)).toBe("test-runs-2026-08-21.csv");
  });
});
