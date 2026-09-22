/**
 * Workbooks as YAML: the file a person exports, edits, shares and imports back.
 *
 * A workbook is a name, the sessions it opens on and the station's layout, and all three are
 * small and flat. So this reads and writes a DELIBERATELY TINY subset of YAML rather than
 * pulling a parser in: two-space indentation, `key: scalar`, a list of scalars, and a list of
 * maps whose only nested value is a list of scalars. That is the whole grammar.
 *
 * The reader is STRICT on purpose. A permissive parser guesses, and a guess here silently
 * produces a dashboard that is not the one in the file; every line it does not recognise is a
 * refusal naming the line number instead. The writer quotes anything that could be read as
 * something else, so a round trip is exact.
 *
 * The layout is the station's own model (`flight-test-station/frontend/src/layout/dashboard.ts`)
 * and stays opaque here, exactly as it is in `lib/workbooks.ts`: this file checks the SHAPE of
 * an item — the grid numbers and the parameter keys — and never what a widget means.
 */

export const WORKBOOK_FILE_VERSION = 1;

export interface WorkbookFile {
  version: number;
  name: string;
  sessions: string[];
  layout: WorkbookFileItem[];
}

export interface WorkbookFileItem {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  params?: string[];
}

/** Item keys that must be whole numbers; everything else on an item is a string. */
const NUMERIC_KEYS = ["x", "y", "w", "h"] as const;
const ITEM_KEYS = ["id", "kind", ...NUMERIC_KEYS, "params"] as const;
const MAX_ITEMS = 60;
const MAX_PARAMS = 40;

export class WorkbookYamlError extends Error {}

function fail(line: number, message: string): never {
  throw new WorkbookYamlError(`line ${line}: ${message}`);
}

/* ───────────────────────────── writing ───────────────────────────── */

/** True when a scalar can be written bare. Anything else is quoted. */
function isPlain(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.:=\-/]*$/.test(value) && !/^(?:true|false|null|~)$/i.test(value);
}

function scalar(value: string): string {
  if (value === "") return '""';
  if (isPlain(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function toYaml(workbook: {
  name: string;
  sessions: readonly string[];
  layout: readonly unknown[];
}): string {
  const lines: string[] = [
    "# Test Manager workbook. Import it from the Workbooks screen.",
    `version: ${WORKBOOK_FILE_VERSION}`,
    `name: ${scalar(workbook.name)}`,
  ];
  lines.push("sessions:");
  if (workbook.sessions.length === 0) lines[lines.length - 1] = "sessions: []";
  for (const session of workbook.sessions) lines.push(`  - ${scalar(String(session))}`);

  const items = workbook.layout.filter(isItemLike);
  lines.push("layout:");
  if (items.length === 0) lines[lines.length - 1] = "layout: []";
  for (const item of items) {
    lines.push(`  - id: ${scalar(item.id)}`);
    lines.push(`    kind: ${scalar(item.kind)}`);
    for (const key of NUMERIC_KEYS) lines.push(`    ${key}: ${item[key]}`);
    if (item.params && item.params.length > 0) {
      lines.push("    params:");
      for (const p of item.params) lines.push(`      - ${scalar(p)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function isItemLike(value: unknown): value is WorkbookFileItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.kind === "string" &&
    NUMERIC_KEYS.every((k) => typeof v[k] === "number")
  );
}

/* ───────────────────────────── reading ───────────────────────────── */

interface Line {
  n: number;
  indent: number;
  text: string;
}

function significant(text: string): Line[] {
  return text
    .split(/\r?\n/)
    .map((raw, i) => ({ n: i + 1, indent: raw.length - raw.trimStart().length, text: raw.trim() }))
    .filter((l) => l.text !== "" && !l.text.startsWith("#"));
}

function unquote(raw: string, line: number): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) fail(line, "unterminated quoted value");
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.includes("#")) fail(line, "a bare value may not contain '#'; quote it");
  return value;
}

function splitKey(line: Line): [string, string] {
  const at = line.text.indexOf(":");
  if (at < 0) fail(line.n, `expected 'key: value', got ${JSON.stringify(line.text)}`);
  return [line.text.slice(0, at).trim(), line.text.slice(at + 1).trim()];
}

function readScalarList(lines: Line[], from: number, indent: number, cap: number): [string[], number] {
  const out: string[] = [];
  let i = from;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
    if (out.length === cap) fail(lines[i].n, `more than ${cap} entries`);
    out.push(unquote(lines[i].text.slice(2), lines[i].n));
    i += 1;
  }
  return [out, i];
}

function readItem(lines: Line[], from: number): [WorkbookFileItem, number] {
  const first = lines[from];
  const item: Record<string, unknown> = {};
  const [key, value] = splitKey({ ...first, text: first.text.slice(2) });
  item[key] = unquote(value, first.n);
  let i = from + 1;
  // "- " occupies the two columns after the item's own indent, so its remaining keys line up
  // with the dash's text: `  - id:` at two, `    kind:` at four.
  const indent = first.indent + 2;
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
    const [k, v] = splitKey(lines[i]);
    if (!(ITEM_KEYS as readonly string[]).includes(k)) fail(lines[i].n, `unknown key ${JSON.stringify(k)}`);
    if (k === "params") {
      if (v !== "" && v !== "[]") fail(lines[i].n, "params takes a list on the following lines");
      const [params, next] = readScalarList(lines, i + 1, indent + 2, MAX_PARAMS);
      item.params = params;
      i = next;
      continue;
    }
    item[k] = (NUMERIC_KEYS as readonly string[]).includes(k) ? Number(unquote(v, lines[i].n)) : unquote(v, lines[i].n);
    i += 1;
  }
  for (const k of ["id", "kind"] as const) {
    if (typeof item[k] !== "string" || item[k] === "") fail(first.n, `item needs a ${k}`);
  }
  for (const k of NUMERIC_KEYS) {
    const n = item[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 200)
      fail(first.n, `item needs a whole ${k} between 0 and 200`);
  }
  return [item as unknown as WorkbookFileItem, i];
}

export function fromYaml(text: string): WorkbookFile {
  const lines = significant(text);
  if (lines.length === 0) throw new WorkbookYamlError("the file is empty");
  const file: WorkbookFile = { version: 0, name: "", sessions: [], layout: [] };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== 0) fail(line.n, "expected a top-level key");
    const [key, value] = splitKey(line);
    i += 1;
    if (key === "version") file.version = Number(unquote(value, line.n));
    else if (key === "name") file.name = unquote(value, line.n);
    else if (key === "sessions") {
      if (value !== "" && value !== "[]") fail(line.n, "sessions takes a list on the following lines");
      [file.sessions, i] = readScalarList(lines, i, 2, MAX_ITEMS);
    } else if (key === "layout") {
      if (value !== "" && value !== "[]") fail(line.n, "layout takes a list on the following lines");
      while (i < lines.length && lines[i].indent === 2 && lines[i].text.startsWith("- ")) {
        if (file.layout.length === MAX_ITEMS) fail(lines[i].n, `more than ${MAX_ITEMS} widgets`);
        const [item, next] = readItem(lines, i);
        file.layout.push(item);
        i = next;
      }
    } else fail(line.n, `unknown key ${JSON.stringify(key)}`);
  }
  if (file.version !== WORKBOOK_FILE_VERSION)
    throw new WorkbookYamlError(
      `this file says version ${file.version || "nothing"}; this Test Manager reads version ${WORKBOOK_FILE_VERSION}`,
    );
  if (file.name.trim() === "") throw new WorkbookYamlError("the file names no workbook");
  return file;
}
