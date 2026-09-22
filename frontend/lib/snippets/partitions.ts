/**
 * A snippet's partitions the way QuixLab's console shows them: the levels every folder shares
 * as a row of value chips, then a table of the levels that tell the folders apart. Pure; the
 * rules are copied from quixlab `lake-partitions.js` (`selectionHtml`, `columnsOf`, `sharedOf`).
 */

const NONE = "__None__";

export interface PartitionRow {
  path: string;
  values: Record<string, string>;
}

export interface PartitionSummary {
  /** True when a path is the table root: every row of the table. */
  whole: boolean;
  rows: PartitionRow[];
  /** Keys whose value is the same on every folder, in first-seen order. */
  shared: { key: string; value: string }[];
  /** The keys that tell the folders apart; empty for a lone folder, which is all chips. */
  columns: string[];
}

/** `key=value` segments of one folder path, in order; a segment without `=` is skipped. */
export function segments(path: string): [string, string][] {
  const out: [string, string][] = [];
  for (const seg of path.split("/")) {
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    let value = seg.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      /* a raw percent sign stays as written */
    }
    out.push([seg.slice(0, eq), value]);
  }
  return out;
}

/** `(none)` for the lake's spelling of a null partition value. */
export function showValue(v: string | undefined): string {
  if (v === undefined) return "any";
  return v === NONE || v === "" ? "(none)" : v;
}

export function summarisePartitions(paths: readonly string[]): PartitionSummary {
  const whole = paths.includes("");
  const rows: PartitionRow[] = paths
    .filter((p) => p !== "")
    .map((p) => ({ path: p, values: Object.fromEntries(segments(p)) }));
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.values)))];
  // One folder is a breadcrumb: every level a chip, no table. QuixLab tabulates it; chips read
  // better for the one-folder snippet the analyses write most.
  const sharedKeys = keys.filter((k) =>
    rows.every((r) => k in r.values && r.values[k] === rows[0].values[k]),
  );
  const columns = keys.filter((k) => !sharedKeys.includes(k));
  const shared = sharedKeys
    .filter((k) => !columns.includes(k))
    .map((k) => ({ key: k, value: rows[0].values[k] }));
  return { whole, rows, shared, columns };
}
