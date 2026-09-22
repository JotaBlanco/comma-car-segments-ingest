import { describe, expect, it } from "vitest";
import {
  fromYaml,
  toYaml,
  WORKBOOK_FILE_VERSION,
  WorkbookYamlError,
} from "@/lib/workbook-yaml";

const WORKBOOK = {
  name: "A350-1000 — Flight profile",
  sessions: ["sn059_20161124T132527594Z", "sn071_20170331T122843845Z"],
  layout: [
    { id: "altitude", kind: "altitude", x: 0, y: 0, w: 12, h: 8 },
    {
      id: "waveform:1",
      kind: "waveform",
      x: 0,
      y: 8,
      w: 6,
      h: 8,
      params: ["a429:bus=ADR1:ALT_STD_1", "a429:bus=ADR1:CAS_1"],
    },
  ],
};

describe("workbook YAML", () => {
  it("round-trips a workbook exactly", () => {
    const back = fromYaml(toYaml(WORKBOOK));
    expect(back.name).toBe(WORKBOOK.name);
    expect(back.sessions).toEqual(WORKBOOK.sessions);
    expect(back.layout).toEqual(WORKBOOK.layout);
    expect(back.version).toBe(WORKBOOK_FILE_VERSION);
  });

  it("quotes a name that would otherwise read as something else", () => {
    // An em-dash is fine bare in YAML, but a leading '-' or an embedded ': ' is not.
    const text = toYaml({ ...WORKBOOK, name: "cruise: the long leg" });
    expect(text).toContain('name: "cruise: the long leg"');
    expect(fromYaml(text).name).toBe("cruise: the long leg");
  });

  it("writes an empty workbook as empty lists, and reads them back", () => {
    const text = toYaml({ name: "Empty", sessions: [], layout: [] });
    expect(text).toContain("sessions: []");
    expect(text).toContain("layout: []");
    const back = fromYaml(text);
    expect(back.sessions).toEqual([]);
    expect(back.layout).toEqual([]);
  });

  it("keeps parameter keys verbatim, colons and all", () => {
    const back = fromYaml(toYaml(WORKBOOK));
    expect(back.layout[1].params).toEqual(["a429:bus=ADR1:ALT_STD_1", "a429:bus=ADR1:CAS_1"]);
  });

  it("ignores comments and blank lines", () => {
    const text = `# a workbook\n\nversion: 1\nname: One\nsessions: []\n\nlayout: []\n`;
    expect(fromYaml(text).name).toBe("One");
  });

  // --- the refusals. A permissive parser guesses, and a guess is a wrong dashboard. ---

  it("refuses a file from a version it does not read", () => {
    const text = toYaml(WORKBOOK).replace("version: 1", "version: 2");
    expect(() => fromYaml(text)).toThrow(/version 2/);
  });

  it("refuses a key it does not know, naming the line", () => {
    const text = toYaml(WORKBOOK).replace("name:", "nmae:");
    expect(() => fromYaml(text)).toThrow(/line 3/);
  });

  it("refuses an item key it does not know", () => {
    const text = toYaml(WORKBOOK).replace("    kind: altitude", "    knid: altitude");
    expect(() => fromYaml(text)).toThrow(WorkbookYamlError);
  });

  it("refuses a grid number that is not a whole number", () => {
    const text = toYaml(WORKBOOK).replace("    w: 12", "    w: 12.5");
    expect(() => fromYaml(text)).toThrow(/whole w/);
  });

  it("refuses an item with no id", () => {
    expect(() => fromYaml("version: 1\nname: X\nlayout:\n  - kind: map\n    x: 0\n")).toThrow(
      WorkbookYamlError,
    );
  });

  it("refuses a file that names no workbook", () => {
    expect(() => fromYaml("version: 1\nname: \"\"\nlayout: []\n")).toThrow(/names no workbook/);
  });

  it("refuses an empty file", () => {
    expect(() => fromYaml("   \n\n")).toThrow(/empty/);
  });

  it("refuses an unterminated quote rather than reading past it", () => {
    expect(() => fromYaml('version: 1\nname: "unclosed\n')).toThrow(/unterminated/);
  });

  it("caps the widgets it will read", () => {
    const many = Array.from({ length: 61 }, (_, i) => `  - id: w${i}\n    kind: map\n    x: 0\n    y: 0\n    w: 1\n    h: 1`).join("\n");
    expect(() => fromYaml(`version: 1\nname: Many\nlayout:\n${many}\n`)).toThrow(/more than 60/);
  });
});
