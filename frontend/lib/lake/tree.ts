/**
 * The lake's hive path, as text: `platform=AC3/work_order=WO-2026-0915`.
 *
 * The catalog answers one level at a time (`GET /partitions?table=&path=`) and
 * names each node by its folder — `column=value`. Everything that walks the
 * tree needs the same four operations on those names, so they live here, in a
 * module with no imports: a client component, a route handler and a test all
 * read the same rules.
 *
 * Nothing here is server-side; `proxy.ts` and `console.ts` in this folder are,
 * and this file deliberately imports neither.
 */

/**
 * The lake's placeholder for a level that has files but no value — a NULL
 * partition value, or a virtual level nothing indexed yet. It is a real
 * folder name, so it travels through paths untouched and is only ever
 * SHOWN differently.
 */
export const NONE_VALUE = "__None__";

/** The value the sink writes when a batch names no work order (`lake-sink/main.py`). */
export const UNKNOWN_VALUE = "unknown";

export interface Segment {
  column: string;
  value: string;
}

/**
 * One folder name as a segment. The split is at the FIRST `=`: a value may
 * hold one (`bench_sw=v1=2`), a column may not. A name without `=` is not a
 * partition folder and yields null.
 */
export function parseSegment(name: string): Segment | null {
  const at = name.indexOf("=");
  if (at <= 0) return null;
  return { column: name.slice(0, at), value: name.slice(at + 1) };
}

/** A segment as the lake spells it. */
export function segmentName({ column, value }: Segment): string {
  return `${column}=${value}`;
}

/** Segments as a path the `path=` parameter takes. Empty for the root. */
export function pathOf(segments: readonly Segment[]): string {
  return segments.map(segmentName).join("/");
}

/** A path back into segments, anything unreadable dropped. */
export function parsePath(path: string): Segment[] {
  return String(path ?? "")
    .split("/")
    .filter((part) => part !== "")
    .map(parseSegment)
    .filter((s): s is Segment => s !== null);
}

/**
 * Segments as the equality filters the catalog's value lookup takes
 * (`GET /partition-values?…&<column>=<value>`). The deepest wins if a column
 * somehow repeats.
 */
export function filtersOf(segments: readonly Segment[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { column, value } of segments) out[column] = value;
  return out;
}

/**
 * A partition value as a person reads it. The lake's two "nothing here"
 * spellings both read as "(none)"; every other value is its own text.
 */
export function displayValue(value: string): string {
  return value === NONE_VALUE || value === UNKNOWN_VALUE || value === "" ? "(none)" : value;
}

/* ───────────────────────── the registry join ─────────────────────────
 *
 * A partition column is joined to a Test Manager entity by NAME, not by
 * position: `work_order` holds work-order ids wherever the operator puts that
 * level, and a column no rule below matches is shown by its value alone. The
 * rule lives here because both the sessions dialog and the mock rig's tree
 * read it, and they must agree on what a folder means.
 */

export type EntityKind = "work_order" | "test_definition" | "project";

export function entityKind(column: string): EntityKind | null {
  const k = column.toLowerCase().replace(/[^a-z]/g, "");
  if (["workorder", "workorderid", "wo", "woid"].includes(k)) return "work_order";
  if (["testdefinition", "testdefinitionid", "definition", "definitionid", "td", "tdid"].includes(k))
    return "test_definition";
  if (k === "platform" || k === "project") return "project";
  return null;
}
