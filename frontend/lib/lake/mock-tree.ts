/* The lake's partition tree on the MOCK rig.
 *
 * `TM_USE_MOCK_API` / `TM_TEST_HOOKS` run the front end with no lake behind
 * it, and the sessions dialog reads the tree for everything it shows. Without
 * an answer here the dialog is empty on the rig a developer and the e2e suite
 * both use, so the seeded runs are folded into the same shape the catalog
 * answers with: one folder per distinct value of the level asked for, under
 * the values already pinned.
 *
 * The mapping is the join rule of `tree.ts` read backwards — a `work_order`
 * level holds the run's work-order id, a `project`/`platform` level its
 * project — so the mock tree carries exactly what the dialog then joins back.
 * A run that names none of them lands under the lake's own `__None__`
 * placeholder, which is where the real lake puts it too.
 *
 * Server-side only: it reads the mock database. */

import { getDb } from "@/lib/mock/db";
import type { RunRecord } from "@/lib/mock/seed";
import { parsePartitionColumns, sessionColumnsOf } from "@/lib/explore/lake-partitions";
import { entityKind, NONE_VALUE, parseSegment, type Segment } from "./tree";

/** The session address this server is configured for. */
function columns(): readonly string[] {
  return sessionColumnsOf(parsePartitionColumns(process.env.TM_LAKE_SESSION_PARTITIONS));
}

/** One run's value at a partition level, the lake's placeholder when it has none. */
function valueAt(run: RunRecord, column: string, sessionAt: string): string {
  if (column === sessionAt) return run.run_id;
  const kind = entityKind(column);
  if (kind === "work_order") return run.work_order_id ?? NONE_VALUE;
  if (kind === "test_definition") return run.definition_id ?? NONE_VALUE;
  if (kind === "project") return run.project ?? NONE_VALUE;
  return NONE_VALUE;
}

function matches(run: RunRecord, pinned: readonly Segment[], sessionAt: string): boolean {
  return pinned.every(({ column, value }) => valueAt(run, column, sessionAt) === value);
}

/** The folders under `path`, in the shape `GET /partitions` answers with. */
export function mockPartitionLevel(path: string): { name: string; path: string; has_children: boolean; file_count: number }[] {
  const cols = columns();
  const sessionAt = cols[cols.length - 1];
  const pinned = String(path ?? "")
    .split("/")
    .filter((part) => part !== "")
    .map(parseSegment)
    .filter((s): s is Segment => s !== null);
  const column = cols[pinned.length];
  if (column === undefined) return [];
  const counts = new Map<string, number>();
  for (const run of getDb().runs) {
    if (!matches(run, pinned, sessionAt)) continue;
    const value = valueAt(run, column, sessionAt);
    counts.set(value, (counts.get(value) ?? 0) + run.file_count);
  }
  const prefix = path === "" ? "" : `${path}/`;
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([value, files]) => ({
      name: `${column}=${value}`,
      path: `${prefix}${column}=${value}`,
      has_children: pinned.length + 1 < cols.length,
      file_count: files,
    }));
}

/** The distinct values of one column under the pinned ancestors. */
export function mockPartitionValues(column: string, where: Readonly<Record<string, unknown>>): string[] {
  const cols = columns();
  /* A level INSIDE a session is the Explorer's half of the tree, and the mock
     rig holds no lake to answer it from. Saying so with an empty list beats
     answering every run's placeholder. */
  if (!cols.includes(column)) return [];
  const sessionAt = cols[cols.length - 1];
  const pinned: Segment[] = Object.entries(where)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ({ column: k, value: String(v) }));
  const values = new Set<string>();
  for (const run of getDb().runs) {
    if (!matches(run, pinned, sessionAt)) continue;
    values.add(valueAt(run, column, sessionAt));
  }
  return [...values].sort();
}
