/**
 * Opening the Explorer on something: a run, or an issue's signal and period. The link
 * carries the run and what the issue names; the page turns that into the Explorer's own
 * layout, rooted on the run's partition folder, with the period as the range.
 *
 * Which folders address a session and which lie inside one is the operator's
 * statement, not a guess about the table: both halves come from
 * `lib/explore/lake-partitions.ts`. The sessions dialog picks with the first
 * half, the Explorer's own tree walks the second.
 */

import { dataColumns, sessionColumn, sessionColumns } from "./lake-partitions";

export interface ExploreEntry {
  run: string;
  /** `bus=INS1`, `fcc=2`: the partition level under the run the issue names. */
  scope?: string | null;
  signal?: string | null;
  frame?: { t0_ms: number; t1_ms: number } | null;
}

/** The padding around an instant or a short period, so it reads as a window. */
const MIN_SPAN_MS = 10_000;

export function exploreHref(e: ExploreEntry): string {
  const q = new URLSearchParams({ run: e.run });
  if (e.scope) q.set("scope", e.scope);
  if (e.signal) q.set("signal", e.signal);
  if (e.frame) {
    q.set("t0", String(e.frame.t0_ms));
    q.set("t1", String(e.frame.t1_ms));
  }
  return `/explore?${q.toString()}`;
}

export function readExploreEntry(params: URLSearchParams | null): ExploreEntry | null {
  const run = params?.get("run");
  if (!run) return null;
  const e: ExploreEntry = { run, scope: params?.get("scope") ?? null, signal: params?.get("signal") ?? null };
  const t0 = Number(params?.get("t0"));
  const t1 = Number(params?.get("t1"));
  if (Number.isFinite(t0) && Number.isFinite(t1) && t0 > 0 && t1 >= t0) e.frame = { t0_ms: t0, t1_ms: t1 };
  return e;
}

/** The range the Explorer opens on: the period, widened to read as a window. */
export function exploreRange(frame: { t0_ms: number; t1_ms: number }): { from: number; to: number } {
  const span = frame.t1_ms - frame.t0_ms;
  const pad = Math.max(0, (MIN_SPAN_MS - span) / 2) + Math.max(1000, span * 0.1);
  return { from: Math.floor(frame.t0_ms - pad), to: Math.ceil(frame.t1_ms + pad) };
}

const NONE = "__None__";
/** The protocol a scope key names: the station's own table kinds. */
const PROTOCOL_OF: Record<string, string> = { bus: "a429", stream: "analog", fcc: "fto" };

/**
 * A session's partition folder: every level of its address, outermost first,
 * down to the session itself. The outer levels come from one partition
 * combination of the run, and a level the combination does not name takes the
 * lake's own placeholder — which is the folder the lake wrote for it.
 */
export function rootPath(combination: Readonly<Record<string, unknown>>, run: string): string {
  const columns = sessionColumns();
  if (columns.length === 0) return "";
  return columns
    .map((col, i) => {
      const v = i === columns.length - 1 ? run : combination[col];
      return `${col}=${v === undefined || v === null ? NONE : String(v)}`;
    })
    .join("/");
}

/**
 * An issue's signal as the merged tree names it: the levels INSIDE the
 * session, from the protocol the scope key implies down to the signal.
 *
 * A data level the issue does not name is skipped, not fatal. The levels
 * inside a session are virtual, and the lake indexes only the ones a file
 * actually carries — an A429 file has a `bus` and no `fcc` — so the tree's
 * own path for a signal holds exactly the levels that apply to it. Empty when
 * the issue names no signal, which is the one level the path cannot do
 * without.
 */
export function signalPath(entry: ExploreEntry): string {
  if (!entry.signal) return "";
  const columns = dataColumns();
  const leaf = columns[columns.length - 1];
  const scope = entry.scope ? entry.scope.split("=") : null;
  const segs: string[] = [];
  let reachedLeaf = false;
  for (const col of columns) {
    let v: string | null = null;
    if (col === leaf) {
      v = entry.signal;
      reachedLeaf = true;
    } else if (col === "protocol" && scope !== null) v = PROTOCOL_OF[scope[0]] ?? null;
    else if (scope !== null && scope[0] === col) v = scope[1] ?? null;
    if (v === null) continue;
    segs.push(`${col}=${v}`);
  }
  return reachedLeaf ? segs.join("/") : "";
}

export interface ExploreLayout {
  table: string;
  range?: { mode: "absolute"; from: number; to: number };
  signals?: { id: string; name: string }[];
}

type Fetch = (url: string) => Promise<unknown>;

/** The layout the Explorer opens with for an entry: the issue's signal ticked, the period as the range. */
export async function resolveExploreLayout(
  entry: ExploreEntry,
  table: string,
): Promise<ExploreLayout> {
  const layout: ExploreLayout = { table };
  if (entry.frame) layout.range = { mode: "absolute", ...exploreRange(entry.frame) };
  if (!entry.signal) return layout;
  /* The levels inside a session are configuration, so naming the signal costs
     no call: the `/partition-info` read this used to make said the same thing
     for this table and nothing when the lake was unreachable. */
  const id = signalPath(entry);
  if (id !== "") layout.signals = [{ id, name: entry.signal }];
  return layout;
}

/**
 * The folders to root the Explorer's tree on for a set of sessions: one per run, so the
 * tree shows the data folders under each run and nothing above them. A run the lake
 * has no folder for is left out.
 */
export async function resolveRoots(runs: readonly string[], table: string, get: Fetch): Promise<string[]> {
  if (runs.length === 0) return [];
  const column = sessionColumn();
  const roots = await Promise.all(
    runs.map(async (run) => {
      try {
        const q = new URLSearchParams({ table, limit: "1", where: JSON.stringify({ [column]: run }) });
        const combos = (await get(`/api/lake/partition-combinations?${q}`)) as { combinations?: unknown };
        const first = Array.isArray(combos?.combinations) ? combos.combinations[0] : undefined;
        if (typeof first !== "object" || first === null) return "";
        return rootPath(first as Record<string, unknown>, run);
      } catch {
        return "";
      }
    }),
  );
  return roots.filter((r) => r !== "");
}
