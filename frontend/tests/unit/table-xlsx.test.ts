/**
 * The Excel export of a list screen (FR-DM-018, Excel half).
 *
 * The test reads the produced bytes, never the writer's input. It opens the
 * `.xlsx` as the ZIP it is, inflates the parts with Node's own `zlib`, and
 * asserts on `xl/worksheets/sheet1.xml`, `xl/sharedStrings.xml` and
 * `xl/styles.xml`. The file a person opens in Excel is the thing under test.
 *
 * Config: `vitest.unit.config.ts` takes `tests/unit/**`.
 */
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chooseColumns, type CsvColumn } from "@/lib/table-csv";
import { XLSX_DATE_FORMAT, listToXlsxBlob } from "@/lib/table-xlsx";

interface Row {
  name: string;
  unit: string | null;
  runs: number;
  seen: string;
}

const COLUMNS: readonly CsvColumn<Row>[] = [
  { header: "Signal", value: (row) => row.name },
  { header: "Unit", value: (row) => row.unit },
  { header: "Runs", value: (row) => row.runs, type: "number" },
  { header: "First seen", value: (row) => row.seen, type: "date" },
];

const ROWS: readonly Row[] = [
  { name: "batt_temp", unit: "degC", runs: 12, seen: "2026-08-19T07:15:00Z" },
];

/** Signatures of the three ZIP records this reader walks. */
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_ENTRY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/**
 * Read every part of a ZIP as text.
 *
 * The reader walks the central directory, so it never depends on the sizes in
 * a local header. A deflated entry goes through `inflateRawSync`; a stored
 * entry travels as it is.
 */
function readZipParts(bytes: Buffer): Record<string, string> {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== END_OF_CENTRAL_DIRECTORY) end -= 1;
  expect(end).toBeGreaterThanOrEqual(0);

  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const parts: Record<string, string> = {};

  for (let index = 0; index < count; index += 1) {
    expect(bytes.readUInt32LE(at)).toBe(CENTRAL_ENTRY);
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localAt = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    expect(bytes.readUInt32LE(localAt)).toBe(LOCAL_HEADER);
    const localNameLength = bytes.readUInt16LE(localAt + 26);
    const localExtraLength = bytes.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const body = bytes.subarray(dataAt, dataAt + compressedSize);
    parts[name] = (method === 8 ? inflateRawSync(body) : body).toString("utf8");

    at += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}

async function xlsxParts(
  columns: readonly CsvColumn<Row>[],
  rows: readonly Row[] = ROWS,
): Promise<Record<string, string>> {
  const blob = await listToXlsxBlob(columns, rows);
  return readZipParts(Buffer.from(await blob.arrayBuffer()));
}

/** The strings of `xl/sharedStrings.xml`, in the order the sheet indexes them. */
function sharedStrings(parts: Record<string, string>): string[] {
  return [...(parts["xl/sharedStrings.xml"] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(
    (match) => match[1],
  );
}

/** One `<c …>…</c>` element of `xl/worksheets/sheet1.xml`, by its reference. */
function cellXml(parts: Record<string, string>, reference: string): string {
  const sheet = parts["xl/worksheets/sheet1.xml"] ?? "";
  const found = new RegExp(`<c r="${reference}"[^>]*>[\\s\\S]*?</c>`).exec(sheet);
  expect(found, `no cell ${reference} in the sheet`).not.toBeNull();
  return found![0];
}

describe("the Excel file is a real xlsx", () => {
  it("carries the parts a spreadsheet needs", async () => {
    const parts = await xlsxParts(COLUMNS);

    expect(Object.keys(parts)).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/worksheets/sheet1.xml",
      ]),
    );
  });
});

describe("the Excel file carries the chosen columns", () => {
  it("writes the chosen headers and drops the rest", async () => {
    const parts = await xlsxParts(chooseColumns(COLUMNS, ["First seen", "Signal"]));
    const strings = sharedStrings(parts);

    // The declared order, never the order a person clicked.
    expect(strings.slice(0, 2)).toEqual(["Signal", "First seen"]);
    // "Unit" and "Runs" were not chosen, so no part of the file names them.
    expect(strings).not.toContain("Unit");
    expect(strings).not.toContain("Runs");
    // Two headers, so the header row ends at column B.
    expect(parts["xl/worksheets/sheet1.xml"]).not.toContain('r="C1"');
  });

  it("writes every header when a person chooses nothing", async () => {
    const parts = await xlsxParts(chooseColumns(COLUMNS, []));

    expect(sharedStrings(parts).slice(0, 4)).toEqual(["Signal", "Unit", "Runs", "First seen"]);
    expect(parts["xl/worksheets/sheet1.xml"]).toContain('r="D1"');
  });
});

describe("the Excel file types its cells", () => {
  it("writes a number as a number, not as a string", async () => {
    const parts = await xlsxParts(COLUMNS);

    // A shared string carries `t="s"`. A numeric cell carries no `t` at all.
    expect(cellXml(parts, "C2")).toBe('<c r="C2"><v>12</v></c>');
    expect(sharedStrings(parts)).not.toContain("12");
  });

  it("writes a date as a serial number under a date format", async () => {
    const parts = await xlsxParts(COLUMNS);
    const cell = cellXml(parts, "D2");

    // A date cell carries a style index and no `t="s"`.
    expect(cell).not.toContain('t="s"');
    const style = /s="(\d+)"/.exec(cell);
    expect(style, `no style on the date cell ${cell}`).not.toBeNull();

    // The style points at a number format, and that format prints a date.
    const styles = parts["xl/styles.xml"] ?? "";
    expect(styles).toContain(`formatCode="${XLSX_DATE_FORMAT}"`);
    const numberFormatId = /<numFmt numFmtId="(\d+)"/.exec(styles)?.[1];
    expect(numberFormatId).toBeDefined();
    const cellFormats = [...styles.matchAll(/<xf[^>]*>/g)].map((match) => match[0]);
    expect(cellFormats[Number(style![1])]).toContain(`numFmtId="${numberFormatId}"`);

    // 2026-08-19T07:15:00Z is day 46253 of the 1900 epoch, at 07:15.
    const serial = Number(/<v>([\d.]+)<\/v>/.exec(cell)?.[1]);
    expect(Math.floor(serial)).toBe(46253);
    expect(serial - 46253).toBeCloseTo(7.25 / 24, 6);
  });

  it("writes text as a shared string", async () => {
    const parts = await xlsxParts(COLUMNS);

    expect(cellXml(parts, "A2")).toContain('t="s"');
    expect(sharedStrings(parts)).toContain("batt_temp");
  });

  it("leaves an absent value empty, never a dash", async () => {
    const parts = await xlsxParts(COLUMNS, [
      { name: "batt_temp", unit: null, runs: 0, seen: "2026-08-19T07:15:00Z" },
    ]);

    expect(parts["xl/worksheets/sheet1.xml"]).not.toContain('r="B2"');
    expect(parts["xl/sharedStrings.xml"]).not.toContain("—");
  });

  it("falls back to text when a date value does not parse", async () => {
    const parts = await xlsxParts(COLUMNS, [
      { name: "batt_temp", unit: "degC", runs: 1, seen: "not a date" },
    ]);

    expect(cellXml(parts, "D2")).toContain('t="s"');
    expect(sharedStrings(parts)).toContain("not a date");
  });
});
