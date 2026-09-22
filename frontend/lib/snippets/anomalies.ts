/**
 * Data snippets as the run page reads them: the lake's saved selections over the run's
 * table (QuixLab writes one per anomaly it finds), narrowed to one run and read for the
 * period, source and note each one carries. Pure: the tab and the route share it.
 */

import type { DataSnippet } from "@/types";

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * One snippet as the lake sends it, filled to the shape the tab reads. The lake omits
 * `tags` (and may omit `partitions`) when a snippet has none; QuixLab's writer sets neither.
 */
export function normaliseSnippet(raw: unknown): DataSnippet | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "number" ? r.id : Number(r.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    name: typeof r.name === "string" ? r.name : "",
    sql: typeof r.sql === "string" ? r.sql : "",
    partitions: strings(r.partitions),
    markdown: typeof r.markdown === "string" ? r.markdown : "",
    tags: strings(r.tags),
    created_at: typeof r.created_at === "string" ? r.created_at : undefined,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : undefined,
  };
}

export interface SnippetFrame {
  t0_ms: number;
  t1_ms: number;
}

/** The run ids a snippet's partition folders name (`.../run_id=<id>/...`). */
export function partitionRunIds(partitions: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of partitions) {
    for (const seg of p.split("/")) {
      if (seg.startsWith("run_id=")) out.add(seg.slice("run_id=".length));
    }
  }
  return [...out];
}

/**
 * The run's snippets: those whose partitions name the run, plus those naming no run at all
 * whose SQL does (the planner had nothing to pin them to).
 */
export function snippetsForRun(snippets: readonly DataSnippet[], runId: string): DataSnippet[] {
  return snippets.filter((s) => {
    const runs = partitionRunIds(s.partitions);
    if (runs.length > 0) return runs.includes(runId);
    return s.sql.includes(`'${runId}'`);
  });
}

function toMs(raw: string): number {
  const n = Number(raw);
  if (raw.length <= 10) return n * 1000;
  if (raw.length <= 13) return n;
  if (raw.length <= 16) return Math.floor(n / 1000);
  return Math.floor(n / 1_000_000);
}

const TIME_LINE = /\bTime\b[*_:]*\s*:?\s*[*_]*\s*(\d{10,19})\s*[-–—]\s*(\d{10,19})/;
const BETWEEN_WORDS = /between\s+timestamps?\s+(\d{10,19})\s+and\s+(\d{10,19})/i;
const SQL_BETWEEN = /"?timestamp"?\s+BETWEEN\s+(\d{10,19})\s+AND\s+(\d{10,19})/i;

/**
 * The period a snippet marks: its note's `Time:` line, else the sentence naming the
 * timestamps, else the SQL window (QuixLab pads that with context, so it comes last).
 */
export function snippetFrame(s: Pick<DataSnippet, "markdown" | "sql">): SnippetFrame | null {
  const m = TIME_LINE.exec(s.markdown) ?? BETWEEN_WORDS.exec(s.markdown) ?? SQL_BETWEEN.exec(s.sql);
  if (m === null) return null;
  const a = toMs(m[1]);
  const b = toMs(m[2]);
  return a <= b ? { t0_ms: a, t1_ms: b } : { t0_ms: b, t1_ms: a };
}

const PARTITIONS_LINE = /\bPartitions\b[*_:]*\s*:?\s*[*_]*\s*([^\n]+)/;
const PAIR = /\b(bus|stream|fcc|signal)\s*=\s*'?([A-Za-z0-9_.:()-]+)'?/g;

export interface SnippetSource {
  scope: string | null;
  signal: string | null;
}

/** `bus=INS1` and the signal, from the note's Partitions line, else the SQL, else the name. */
export function snippetSource(s: Pick<DataSnippet, "markdown" | "sql" | "name">): SnippetSource {
  for (const text of [PARTITIONS_LINE.exec(s.markdown)?.[1] ?? "", s.sql]) {
    const pairs = new Map<string, string>();
    for (const m of text.matchAll(PAIR)) pairs.set(m[1].toLowerCase(), m[2]);
    const scopeKey = ["bus", "stream", "fcc"].find((k) => pairs.has(k));
    const scope = scopeKey ? `${scopeKey}=${pairs.get(scopeKey)}` : null;
    const signal = pairs.get("signal") ?? null;
    if (scope !== null || signal !== null) return { scope, signal };
  }
  const parts = s.name.split("·").map((p) => p.trim());
  if (parts.length >= 2 && parts[0] && parts[1]) return { scope: `bus=${parts[0]}`, signal: parts[1] };
  return { scope: null, signal: null };
}

/** The first plain sentence of the note: no heading, no `Label:` line, no emphasis marks. */
export function snippetNote(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/[*`]+/g, "").trim();
    if (line === "" || /^\s*#/.test(raw) || /^[A-Za-z ]{2,20}:\s/.test(line)) continue;
    return line.length > 240 ? `${line.slice(0, 239)}…` : line;
  }
  return "";
}

/**
 * The runs a snippet belongs to: the one its SQL pins (`run_id = '…'`), else those its
 * partition folders name. A whole-table snippet names none.
 */
export function snippetRuns(s: Pick<DataSnippet, "sql" | "partitions">): string[] {
  const pinned = [...s.sql.matchAll(/\brun_id\s*=\s*'([^']+)'/g)].map((m) => m[1]);
  if (pinned.length > 0) return [...new Set(pinned)];
  return partitionRunIds(s.partitions);
}

export type SnippetSortKey = "updated" | "name" | "partitions" | "kind" | "state";
export type SortDir = "asc" | "desc";

export function searchSnippets(snippets: readonly DataSnippet[], query: string): DataSnippet[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...snippets];
  return snippets.filter((s) => {
    const hay = [s.name, s.markdown, s.sql, s.partitions.join(" "), s.tags.join(" ")]
      .join("\n")
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export function sortSnippets(
  snippets: readonly DataSnippet[],
  key: SnippetSortKey,
  dir: SortDir,
): DataSnippet[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...snippets].sort((a, b) => {
    let d = 0;
    if (key === "name") d = a.name.localeCompare(b.name);
    else if (key === "partitions") d = a.partitions.length - b.partitions.length;
    else if (key === "kind") d = snippetTags(a).kind.localeCompare(snippetTags(b).kind);
    else if (key === "state") d = stateRank(snippetTags(a).state) - stateRank(snippetTags(b).state);
    else d = (a.updated_at ?? "").localeCompare(b.updated_at ?? "");
    return d === 0 ? a.id - b.id : d * sign;
  });
}

/** Open first: it needs attention. */
function stateRank(state: SnippetState | null): number {
  if (state === null) return 3;
  return SNIPPET_STATES.indexOf(state);
}

/** `14:03:10.500 → 14:07:22.000 Z`, or the single instant. */
export function formatFrame(f: SnippetFrame): string {
  const at = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
  };
  if (f.t1_ms <= f.t0_ms) return `${at(f.t0_ms)} Z`;
  return `${at(f.t0_ms)} → ${at(f.t1_ms)} Z`;
}

/** `1.2 s`, `450 ms`, `2m 05s`, or `instant`. */
export function formatSpan(f: SnippetFrame): string {
  const ms = f.t1_ms - f.t0_ms;
  if (ms <= 0) return "instant";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/* ───────────────────────── QuixLab's tags ─────────────────────────
   QuixLab tags every snippet it writes, in order: `quixlab-store`, the store node id, the
   analysis id (omitted when the store has none), the kind, the state, and `reference` on a
   snippet that sits on the source table. The kind is what the record is (`anomaly` unless the
   analysis chose `gap`, `outlier`, `drift`, ...). The state is where the engineer left it, and
   QuixLab replaces the tag list on every state change, so the state tag is always current. */

export const QUIXLAB_MARKER_TAG = "quixlab-store";
export const REFERENCE_TAG = "reference";
export const DEFAULT_KIND = "anomaly";

export type SnippetState = "open" | "resolved" | "closed";
export const SNIPPET_STATES: readonly SnippetState[] = ["open", "resolved", "closed"];

function isState(v: string): v is SnippetState {
  return (SNIPPET_STATES as readonly string[]).includes(v);
}

export interface SnippetTags {
  /** True when QuixLab wrote it (the marker tag is present). */
  quixLab: boolean;
  /** The data store node the record belongs to. */
  store: string | null;
  /** The AI cell that found the record, when the store has one. */
  analysis: string | null;
  /** What the record is; `anomaly` when nothing says otherwise. */
  kind: string;
  /** Where the engineer left it; null when nothing says. */
  state: SnippetState | null;
  /** True for a reference snippet: a plain slice of the source table. */
  reference: boolean;
  /** Tags outside QuixLab's scheme, in their order. */
  other: string[];
}

const KIND_LINE = /\*\*Kind:\*\*\s*([A-Za-z0-9._-]+)/;
const STATE_LINE = /\*\*State:\*\*\s*(open|resolved|closed)\b/i;

/**
 * QuixLab's tags read by position, with the note's `Kind:` and `State:` lines as the fallback.
 * The store is the first tag after the marker and the kind the last before the state, so the
 * reading holds whether or not the analysis id sits between them.
 */
export function snippetTags(s: Pick<DataSnippet, "tags" | "markdown">): SnippetTags {
  const tags = s.tags.filter((t) => t !== "");
  const noteKind = KIND_LINE.exec(s.markdown)?.[1]?.toLowerCase() ?? null;
  const noteState = STATE_LINE.exec(s.markdown)?.[1]?.toLowerCase() ?? null;
  const quixLab = tags.includes(QUIXLAB_MARKER_TAG);
  if (!quixLab) {
    const state = tags.find(isState) ?? noteState;
    return {
      quixLab: false,
      store: null,
      analysis: null,
      kind: noteKind ?? DEFAULT_KIND,
      state: state !== null && state !== undefined && isState(state) ? state : null,
      reference: tags.includes(REFERENCE_TAG),
      other: tags.filter((t) => !isState(t) && t !== REFERENCE_TAG),
    };
  }
  const rest = tags.filter((t) => t !== QUIXLAB_MARKER_TAG);
  const state = rest.find(isState) ?? null;
  const reference = rest.includes(REFERENCE_TAG);
  const core = rest.filter((t) => !isState(t) && t !== REFERENCE_TAG);
  const store = core[0] ?? null;
  const kind = core.length >= 2 ? core[core.length - 1] : (noteKind ?? DEFAULT_KIND);
  const analysis = core.length >= 3 ? core[1] : null;
  const fallbackState = noteState !== null && isState(noteState) ? noteState : null;
  const named = new Set([store, analysis, core.length >= 2 ? kind : null]);
  return {
    quixLab: true,
    store,
    analysis,
    kind,
    state: state ?? fallbackState,
    reference,
    other: core.filter((t) => !named.has(t)),
  };
}

export interface SnippetFilter {
  state?: SnippetState | "all";
  kind?: string | "all";
  store?: string | "all";
}

export function filterSnippets(
  snippets: readonly DataSnippet[],
  filter: SnippetFilter,
): DataSnippet[] {
  const state = filter.state ?? "all";
  const kind = filter.kind ?? "all";
  const store = filter.store ?? "all";
  if (state === "all" && kind === "all" && store === "all") return [...snippets];
  return snippets.filter((s) => {
    const t = snippetTags(s);
    if (state !== "all" && t.state !== state) return false;
    if (kind !== "all" && t.kind !== kind) return false;
    if (store !== "all" && t.store !== store) return false;
    return true;
  });
}

export interface SnippetFacets {
  kinds: string[];
  stores: string[];
  /** How many snippets sit in each state; `none` counts those that state nothing. */
  states: Record<SnippetState | "none", number>;
}

/** The distinct kinds and stores, sorted, and the count per state: the list's filter controls. */
export function snippetFacets(snippets: readonly DataSnippet[]): SnippetFacets {
  const kinds = new Set<string>();
  const stores = new Set<string>();
  const states: SnippetFacets["states"] = { open: 0, resolved: 0, closed: 0, none: 0 };
  for (const s of snippets) {
    const t = snippetTags(s);
    kinds.add(t.kind);
    if (t.store !== null) stores.add(t.store);
    states[t.state ?? "none"] += 1;
  }
  return { kinds: [...kinds].sort(), stores: [...stores].sort(), states };
}

/**
 * The snippet as it reads once a person moves it to another state: the state tag replaced
 * and the note's `State:` line rewritten. QuixLab replaces the whole tag list on a state
 * change and keeps the marker, the store, the analysis and the kind in front of it, so the
 * new tag takes the old one's place rather than being appended.
 */
export function withState(
  s: Pick<DataSnippet, "tags" | "markdown">,
  state: SnippetState,
): { tags: string[]; markdown: string } {
  const tags = s.tags.filter((t) => t !== "" && !isState(t));
  const at = tags.indexOf(REFERENCE_TAG);
  if (at < 0) tags.push(state);
  else tags.splice(at, 0, state);
  const line = `**State:** ${state}`;
  const markdown = STATE_LINE.test(s.markdown)
    ? s.markdown.replace(STATE_LINE, line)
    : `${s.markdown.replace(/\s*$/, "")}\n${line}\n`;
  return { tags, markdown };
}
