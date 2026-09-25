import type {
  ExploreContext,
  ExploreQueryResult,
  FileDetail,
  FileEntity,
  FileListFilters,
  FileListResponse,
  FileSignal,
  FileViewCounts,
  HomeSummary,
  InvalidFlag,
  ItemsEnvelope,
  JournalEntityType,
  JournalEntry,
  JournalKind,
  LineageResponse,
  Paginated,
  PlanningSyncStatus,
  PlanningSyncToggleResponse,
  ProcessedResult,
  RequirementsFile,
  ResultListFilters,
  RunFacets,
  RunGroup,
  RunGroupBy,
  RunGroupByField,
  RunGroupPage,
  RunListFilters,
  RunListResponse,
  RunPatchBody,
  RunStatus,
  SearchGroup,
  SearchItem,
  SearchResults,
  SignalDetail,
  SignalFacets,
  SignalListFilters,
  SignalListResponse,
  SignalPatchBody,
  SignalRunStatsResponse,
  SignalStatsFilters,
  SourceCount,
  SourceTag,
  StageStatus,
  TestDefinitionDetail,
  TestDefinitionListFilters,
  TestDefinitionListItem,
  TestDefinitionListResponse,
  TestRun,
  TestRunListItem,
  WorkOrderDetail,
  WorkOrderFacets,
  WorkOrderListFilters,
  WorkOrderListResponse,
  WorkOrderListItem,
} from "@/types";
import { CUSTOM_GROUP_PREFIX } from "@/types";
import { MockDbError, notFound, validation } from "./errors";
import {
  formatSize,
  newId,
  nowIso,
  paginate,
  searchRegex,
  type ParsedSort,
  type Pagination,
  type SortOrder,
} from "./helpers";
import {
  createSeedState,
  HERO_RUN_ID,
  SEED_WO_SYNCED_AT,
  SYNC_PROJECT,
  SYNC_TD_ID,
  SYNC_WO_ID,
  VANITY_COUNTS,
  WORK_ORDERS_MIRRORED,
  type DefinitionRecord,
  type FileRecord,
  type JournalRecord,
  type MockState,
  type RunRecord,
  type SignalRecord,
  type WorkOrderRecord,
} from "./seed";

const globalStore = globalThis as typeof globalThis & { __tmMockDb?: MockState };

export function getDb(): MockState {
  globalStore.__tmMockDb ??= createSeedState();
  return globalStore.__tmMockDb;
}

export function resetDb(): void {
  globalStore.__tmMockDb = createSeedState();
}

function runStatus(run: RunRecord): RunStatus {
  if (run.invalid.flagged) return "invalid";
  if (!run.work_order_id) return "awaiting_work_order";
  return "complete";
}

function requireRun(state: MockState, runId: string): RunRecord {
  const run = state.runs.find((r) => r.run_id === runId);
  if (!run) throw notFound("run_not_found", `Run ${runId} not found`);
  return run;
}

function runJournalEntries(state: MockState, runId: string): JournalRecord[] {
  return state.journal.filter(
    (j) => (j.entity_type === "run" && j.entity_id === runId) || j.context_run_id === runId,
  );
}

function toJournalEntry(record: JournalRecord): JournalEntry {
  const { context_run_id: _context, sync_generated: _sync, ...entry } = record;
  return { ...entry, actor_id: record.actor_id ?? null };
}

function toRunListItem(run: RunRecord): TestRunListItem {
  return {
    run_id: run.run_id,
    description: run.description,
    definition_id: run.definition_id,
    work_order_id: run.work_order_id,
    project: run.project,
    rig_id: run.rig_id,
    test_cell: run.test_cell,
    file_count: run.file_count,
    signal_count: run.signal_count,
    first_data_at: run.first_data_at,
    status: runStatus(run),
    invalid: { ...run.invalid },
    // No mock result carries a verdict block, so a run that names a
    // definition carries one unjudged definition and nothing else.
    verdicts: { pass: 0, fail: 0, error: 0, none: run.definition_id === null ? 0 : 1 },
  };
}

function toRunDetail(state: MockState, run: RunRecord): TestRun {
  return {
    ...toRunListItem(run),
    operator: run.operator,
    bench_sw: run.bench_sw,
    started_at: run.started_at,
    ended_at: run.ended_at,
    result_count: state.results.filter((r) => r.run_id === run.run_id).length,
    journal_count: runJournalEntries(state, run.run_id).length,
    field_sources: run.field_sources,
    created_at: run.created_at,
    updated_at: run.updated_at,
    custom_properties: { ...(run.custom_properties ?? {}) },
  };
}

function runIdsWithSignal(state: MockState, name: string): Set<string> {
  const ids = new Set((state.signalRunStats[name] ?? []).map((s) => s.run_id));
  for (const [fileId, signals] of Object.entries(state.fileSignals)) {
    if (!signals.some((s) => s.name === name)) continue;
    const file = state.files.find((f) => f.file_id === fileId);
    if (file?.run_id) ids.add(file.run_id);
  }
  return ids;
}

export const RUNS_SORT_WHITELIST = ["first_data_at"] as const;
export const RUNS_SORT_DEFAULTS: Readonly<Record<(typeof RUNS_SORT_WHITELIST)[number], SortOrder>> =
  { first_data_at: "desc" };

function compareRunsBy(
  key: (typeof RUNS_SORT_WHITELIST)[number],
  order: SortOrder,
): (a: RunRecord, b: RunRecord) => number {
  const dir = order === "asc" ? 1 : -1;
  switch (key) {
    case "first_data_at":
      return (a, b) => a.first_data_at.localeCompare(b.first_data_at) * dir;
  }
}

/** Whole-table quick-view counts for /test-runs — filter-independent. */
export function runsViewCounts(
  state: MockState,
): { all: number; attention: number; invalid: number } {
  return {
    all: state.runs.length,
    attention: state.runs.filter((r) => runStatus(r) !== "complete").length,
    invalid: state.runs.filter((r) => runStatus(r) === "invalid").length,
  };
}

/**
 * The distinct filter values of the whole runs table — contract §2b.
 * Each list sorts ascending. A null project is no project option, because an
 * unlinked run has no project a person can select.
 */
export function runFacets(state: MockState): RunFacets {
  const rigs = new Set<string>();
  const projects = new Set<string>();
  const keys = new Set<string>();
  for (const run of state.runs) {
    if (run.rig_id.trim() !== "") rigs.add(run.rig_id);
    if (run.project !== null && run.project.trim() !== "") projects.add(run.project);
    // FR-DM-108: the Group-by control reads these, so a person picks a
    // criterion of their own instead of typing one.
    for (const key of Object.keys(run.custom_properties ?? {})) keys.add(key);
  }
  return {
    // Plain sort compares UTF-16 code units. Python `sorted` compares code
    // points. The two agree here, so the mock states the API order.
    rigs: [...rigs].sort(),
    projects: [...projects].sort(),
    custom_property_keys: [...keys].sort(),
  };
}

/**
 * Every run the filters keep, in the given order. `listRuns` pages it and
 * `groupRuns` counts it, so a grouped answer and a flat answer always
 * describe the same rows — the same rule the API keeps with one shared query
 * builder (`api/api/services/queries_runs.runs_query`).
 */
function filterRuns(
  state: MockState,
  filters: RunListFilters,
  sort: ParsedSort<(typeof RUNS_SORT_WHITELIST)[number]>,
): MockState["runs"] {
  let runs = [...state.runs].sort(compareRunsBy(sort.key, sort.order));
  if (filters.status && filters.status.length > 0) {
    const set = new Set(filters.status);
    runs = runs.filter((r) => set.has(runStatus(r)));
  }
  if (filters.rig && filters.rig.length > 0) {
    const set = new Set(filters.rig);
    runs = runs.filter((r) => set.has(r.rig_id));
  }
  if (filters.project && filters.project.length > 0) {
    const set = new Set(filters.project);
    runs = runs.filter((r) => r.project !== null && set.has(r.project));
  }
  if (filters.test_cell && filters.test_cell.length > 0) {
    const set = new Set(filters.test_cell);
    runs = runs.filter((r) => r.test_cell !== null && set.has(r.test_cell));
  }
  if (filters.source && filters.source.length > 0) {
    // TR-011: the tag lives in the `field_sources` map, so a run matches when
    // at least one of its fields carries a named tag. An untagged run matches
    // nothing, because nobody recorded a source for it.
    const wanted = new Set<string>(filters.source);
    runs = runs.filter((r) =>
      Object.values(r.field_sources ?? {}).some((entry) => wanted.has(entry.source)),
    );
  }
  if (filters.definition) runs = runs.filter((r) => r.definition_id === filters.definition);
  if (filters.work_order) runs = runs.filter((r) => r.work_order_id === filters.work_order);
  if (filters.signal) {
    const ids = runIdsWithSignal(state, filters.signal);
    runs = runs.filter((r) => ids.has(r.run_id));
  }
  if (filters.q) {
    const rx = searchRegex(filters.q);
    runs = runs.filter(
      (r) =>
        rx.test(r.run_id) ||
        rx.test(r.description) ||
        rx.test(r.rig_id) ||
        rx.test(r.definition_id ?? "") ||
        rx.test(r.work_order_id ?? ""),
    );
  }
  return runs;
}

export function listRuns(
  state: MockState,
  filters: RunListFilters,
  pagination: Pagination,
  sort: ParsedSort<(typeof RUNS_SORT_WHITELIST)[number]> = {
    key: "first_data_at",
    order: RUNS_SORT_DEFAULTS.first_data_at,
  },
): RunListResponse {
  const runs = filterRuns(state, filters, sort);
  return { ...paginate(runs.map(toRunListItem), pagination), view_counts: runsViewCounts(state) };
}

/** The stored field each fixed `group_by` wire name reads — contract §2c. */
const RUN_GROUP_FIELDS: Record<RunGroupByField, "project" | "test_cell" | "rig_id"> = {
  project: "project",
  test_cell: "test_cell",
  rig: "rig_id",
};

/**
 * Contract §2c. Count the runs by one field, biggest group first, then by
 * value. `total` counts the GROUPS, because the page holds groups. A run
 * holding no value forms the `null` group, so the counts still add up to the
 * `total` of the flat list.
 *
 * `custom:<key>` counts by a custom property instead (FR-DM-108). There the
 * runs carrying no such property form no group at all — a custom property is
 * sparse, so a `null` group would hold nearly every run and would say nothing.
 */
export function groupRuns(
  state: MockState,
  groupBy: RunGroupBy,
  filters: RunListFilters,
  pagination: Pagination,
): RunGroupPage {
  const customKey = groupBy.startsWith(CUSTOM_GROUP_PREFIX)
    ? groupBy.slice(CUSTOM_GROUP_PREFIX.length)
    : null;
  const field = customKey === null ? RUN_GROUP_FIELDS[groupBy as RunGroupByField] : null;
  const counts = new Map<string | null, number>();
  for (const run of filterRuns(state, filters, {
    key: "first_data_at",
    order: RUNS_SORT_DEFAULTS.first_data_at,
  })) {
    let value: string | null;
    if (customKey === null) {
      const raw = run[field!] as string | null | undefined;
      value = raw === undefined || raw === null || raw === "" ? null : raw;
    } else {
      const stored = (run.custom_properties ?? {})[customKey];
      if (stored === undefined) continue; // No property, no group.
      value = stored;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const groups: RunGroup[] = [...counts].map(([value, count]) => ({ value, count }));
  groups.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    // Mongo sorts null before every string, so the mock states that order.
    if (a.value === b.value) return 0;
    if (a.value === null) return -1;
    if (b.value === null) return 1;
    return a.value < b.value ? -1 : 1;
  });
  return paginate(groups, pagination);
}

export function getRun(state: MockState, runId: string): TestRun {
  return toRunDetail(state, requireRun(state, runId));
}

/** The two link fields joined the set on 19 Aug 2026 (contract §B #4). */
const RUN_PATCHABLE = [
  "description",
  "operator",
  "bench_sw",
  "work_order_id",
  "definition_id",
] as const;

/** A run field the patch writes. `project` follows the work order. */
type PatchedRunField = (typeof RUN_PATCHABLE)[number] | "project";

/* The limits of the custom property map. `api/api/models/runs.py` holds the
   same three numbers and the same four codes. A run and a test definition both
   read them, so the message names no entity. */
const CUSTOM_PROPERTY_KEY_MAX = 64;
const CUSTOM_PROPERTY_VALUE_MAX = 512;
const CUSTOM_PROPERTY_MAX_COUNT = 50;

/** Refuse a bad property map. Each refusal carries its own code. */
function checkCustomProperties(properties: Record<string, string>): void {
  const entries = Object.entries(properties);
  if (entries.length > CUSTOM_PROPERTY_MAX_COUNT) {
    throw validation(
      "too_many_custom_properties",
      `A custom property map holds ${CUSTOM_PROPERTY_MAX_COUNT} properties at most`,
    );
  }
  for (const [key, value] of entries) {
    if (key.trim().length === 0) {
      throw validation("custom_property_key_required", "A custom property key must not be empty");
    }
    if (key.length > CUSTOM_PROPERTY_KEY_MAX) {
      throw validation(
        "custom_property_key_too_long",
        `The custom property key is longer than ${CUSTOM_PROPERTY_KEY_MAX} characters`,
      );
    }
    if (typeof value !== "string") {
      throw validation("validation_error", `The value of ${key} must be a string`);
    }
    if (value.length > CUSTOM_PROPERTY_VALUE_MAX) {
      throw validation(
        "custom_property_value_too_long",
        `The value of ${key} is longer than ${CUSTOM_PROPERTY_VALUE_MAX} characters`,
      );
    }
  }
}

/** Two property maps hold the same pairs. */
function sameProperties(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** One journal side. The keys sort, so a reorder alone never reads as a change. */
function showProperties(properties: Record<string, string>): string {
  const keys = Object.keys(properties).sort();
  if (keys.length === 0) return "(empty)";
  return keys.map((key) => `${key}=${properties[key]}`).join(", ");
}

/**
 * Check a stated link against the mirror, and return the values the edit writes.
 *
 * A manual link must name a mirrored row, so an unknown id answers 422 with the
 * named code. `api/api/services/queries_runs.py` `_resolve_manual_links` holds
 * the same rule, and it derives `project` from the work order the same way.
 */
function resolveManualLinks(
  state: MockState,
  values: Partial<Record<PatchedRunField, string>>,
): void {
  const woId = values.work_order_id;
  if (woId !== undefined) {
    const mirror = state.workOrders.find((w) => w.wo_id === woId && w.mirrored);
    if (mirror === undefined) {
      throw validation("unknown_work_order", `No work order ${woId} is mirrored here`);
    }
    values.project = mirror.project;
  }
  const tdId = values.definition_id;
  if (tdId !== undefined) {
    const mirror = state.definitions.find((d) => d.td_id === tdId && d.mirrored);
    if (mirror === undefined) {
      throw validation("unknown_definition", `No test definition ${tdId} is mirrored here`);
    }
  }
}

export function patchRun(state: MockState, runId: string, body: RunPatchBody): TestRun {
  const run = requireRun(state, runId);
  if (typeof body.actor !== "string" || body.actor.trim().length === 0) {
    throw validation("validation_error", "actor is required", [
      { loc: ["body", "actor"], msg: "field required", type: "value_error.missing" },
    ]);
  }
  const provided = RUN_PATCHABLE.filter((f) => typeof body[f] === "string");
  /* The map replaces the stored map whole, so `{}` is a clear and not a blank.
     Only an absent field says nothing at all. */
  const properties = body.custom_properties ?? undefined;
  if (provided.length === 0 && properties === undefined) {
    throw new MockDbError(400, "no_fields_to_update", "No patchable fields in request body");
  }
  if (properties !== undefined) checkCustomProperties(properties);
  const values: Partial<Record<PatchedRunField, string>> = {};
  for (const field of provided) values[field] = body[field] as string;
  resolveManualLinks(state, values);

  const at = nowIso();
  for (const field of Object.keys(values) as PatchedRunField[]) {
    const next = values[field] as string;
    const prev = run[field];
    if (prev === next) continue;
    run[field] = next;
    run.field_sources[field] = { source: "manual", actor: body.actor, at };
    state.journal.push({
      id: `j-${crypto.randomUUID()}`,
      entity_type: "run",
      entity_id: runId,
      field: `run.${field}`,
      kind: "change",
      old: prev ?? "(empty)",
      new: next,
      source: "manual",
      actor: body.actor,
      note: body.note ?? null,
      at,
    });
    run.updated_at = at;
  }

  if (properties !== undefined) {
    const previous = run.custom_properties ?? {};
    if (!sameProperties(previous, properties)) {
      run.custom_properties = { ...properties };
      run.field_sources.custom_properties = { source: "manual", actor: body.actor, at };
      state.journal.push({
        id: `j-${crypto.randomUUID()}`,
        entity_type: "run",
        entity_id: runId,
        field: "run.custom_properties",
        kind: "change",
        old: showProperties(previous),
        new: showProperties(properties),
        source: "manual",
        actor: body.actor,
        note: body.note ?? null,
        at,
      });
      run.updated_at = at;
    }
  }
  return toRunDetail(state, run);
}

export function flagInvalid(state: MockState, runId: string, reason: unknown, actor: unknown): TestRun {
  const run = requireRun(state, runId);
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length === 0) {
    throw validation("reason_required", "A reason is required to flag a run invalid", [
      { loc: ["body", "reason"], msg: "must be a non-empty string", type: "value_error" },
    ]);
  }
  if (run.invalid.flagged) {
    throw new MockDbError(409, "already_flagged", `Run ${runId} is already flagged invalid`);
  }
  const actorName = typeof actor === "string" && actor.trim().length > 0 ? actor : "unknown";
  const at = nowIso();
  run.invalid = { flagged: true, reason: trimmed, actor: actorName, at };
  run.updated_at = at;
  state.journal.push({
    id: `j-${crypto.randomUUID()}`,
    entity_type: "run",
    entity_id: runId,
    field: "run.invalid_flag",
    kind: "change",
    old: "false",
    new: "true",
    source: "manual",
    actor: actorName,
    note: trimmed,
    at,
  });
  return toRunDetail(state, run);
}

/**
 * Undo an invalid flag — `DELETE /test-runs/{id}/invalid-flag`, the
 * counterpart of `flagInvalid` above. The real route keeps the reason
 * required (rehearsals need to say why), answers 409 `not_flagged` for a run
 * nobody flagged, and journals the judgment like the flag did
 * (`api/api/services/queries_runs.py` clear_invalid_flag).
 */
export function clearInvalidFlag(
  state: MockState,
  runId: string,
  reason: unknown,
  actor: unknown,
): TestRun {
  const run = requireRun(state, runId);
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length === 0) {
    throw validation("reason_required", "A reason is required to clear an invalid flag", [
      { loc: ["body", "reason"], msg: "must be a non-empty string", type: "value_error" },
    ]);
  }
  if (!run.invalid.flagged) {
    throw new MockDbError(409, "not_flagged", `Run ${runId} is not flagged invalid`);
  }
  const actorName = typeof actor === "string" && actor.trim().length > 0 ? actor : "unknown";
  const at = nowIso();
  run.invalid = { flagged: false, reason: null, actor: null, at: null };
  run.updated_at = at;
  state.journal.push({
    id: `j-${crypto.randomUUID()}`,
    entity_type: "run",
    entity_id: runId,
    field: "run.invalid_flag",
    kind: "change",
    old: "true",
    new: "false",
    source: "manual",
    actor: actorName,
    note: trimmed,
    at,
  });
  return toRunDetail(state, run);
}

/**
 * A free-text note against a run — `POST /test-runs/{id}/journal` (★).
 * Mirrors `queries_runs.add_run_note`: kind "note", no field, manual source.
 */
export function addRunNote(state: MockState, runId: string, note: unknown, actor: unknown): JournalEntry {
  requireRun(state, runId);
  if (typeof note !== "string" || note.trim().length === 0) {
    throw validation("validation_error", "note is required", [
      { loc: ["body", "note"], msg: "must be a non-empty string", type: "value_error" },
    ]);
  }
  if (typeof actor !== "string" || actor.trim().length === 0) {
    throw validation("validation_error", "actor is required", [
      { loc: ["body", "actor"], msg: "field required", type: "value_error.missing" },
    ]);
  }
  const record: JournalRecord = {
    id: `j-${crypto.randomUUID()}`,
    entity_type: "run",
    entity_id: runId,
    field: null,
    kind: "note",
    old: null,
    new: null,
    source: "manual",
    actor,
    note,
    at: nowIso(),
  };
  state.journal.push(record);
  return toJournalEntry(record);
}

/** A record without the field is active — same rule as the real `_lifecycle`. */
function fileLifecycle(file: FileRecord): "active" | "archived" | "deleted" {
  return file.lifecycle ?? "active";
}

/**
 * Read the invalid block of a file. A record without the field is clear —
 * the same rule the real `files.py _invalid` applies to a document the
 * registry stored before 24 Aug 2026.
 */
function fileInvalid(file: FileRecord): InvalidFlag {
  return file.invalid ?? { flagged: false, reason: null, actor: null, at: null };
}

function requireFile(state: MockState, fileId: string): FileRecord {
  const file = state.files.find((f) => f.file_id === fileId);
  if (!file) throw notFound("file_not_found", `File ${fileId} not found`);
  return file;
}

function toFileEntity(file: FileRecord): FileEntity {
  return {
    file_id: file.file_id,
    filename: file.filename,
    run_id: file.run_id,
    source_system: file.source_system,
    // A seeded row states no role and reads as a recording, the same fallback
    // the real API applies to a document stored before the field existed.
    role: file.role ?? "recording",
    format: file.format,
    size_bytes: file.size_bytes,
    checksum_sha256: file.checksum_sha256,
    checksum_state: file.checksum_state,
    status: file.status,
    quarantine_reason: file.quarantine_reason,
    // The 20 Aug 2026 fields, with the same fallbacks the real API applies
    // to a document from before that date: active, version 1, no stage
    // report. The write routes below are the only writers.
    lifecycle: fileLifecycle(file),
    version: file.version ?? 1,
    sync_status: file.sync_status ?? null,
    upload_status: file.upload_status ?? null,
    conversion_status: file.conversion_status ?? null,
    stage_error: file.stage_error ?? null,
    // The 24 Aug 2026 file-level mark. An unmarked record still serves the
    // full block, exactly as the real `FileBody` default does.
    invalid: fileInvalid(file),
    signal_count: file.signal_count,
    time_start: file.time_start,
    time_end: file.time_end,
    registered_at: file.registered_at,
  };
}

export function listRunFiles(state: MockState, runId: string): ItemsEnvelope<FileEntity> {
  requireRun(state, runId);
  const files = state.files.filter((f) => f.run_id === runId).map(toFileEntity);
  return { items: files, total: files.length };
}

function mergedRunSignals(state: MockState, runId: string): FileSignal[] {
  const merged = new Map<string, FileSignal>();
  for (const file of state.files.filter((f) => f.run_id === runId)) {
    for (const signal of state.fileSignals[file.file_id] ?? []) {
      if (!merged.has(signal.name)) merged.set(signal.name, signal);
    }
  }
  return [...merged.values()];
}

/**
 * Write precedence, `manual` > `api:*` > `embedded` (BE-PLAN §3.1).
 * `api/api/provenance.py:39-46` holds the same table for the real API.
 */
const SOURCE_RANK: Record<string, number> = {
  embedded: 0,
  "api:planning": 1,
  "api:config": 1,
  "api:catalogue": 1,
  "api:post-processing": 1,
  manual: 2,
};

function sourceRank(source: SourceTag | null): number {
  return source === null ? 0 : (SOURCE_RANK[source] ?? 0);
}

/**
 * Give every row the unit of the source that wins.
 *
 * A file_signals row carries the unit of its own file header, so it is always
 * `embedded`. A person corrects a unit on the catalog row, so the catalog
 * can hold a higher-ranked answer. `_with_winning_units` in
 * `api/api/services/queries_stats.py:180-212` applies that answer on this
 * route, so the mock applies it too. Without this the screen showed "missing"
 * after a save that had already succeeded.
 */
function withWinningUnits(state: MockState, rows: FileSignal[]): FileSignal[] {
  const catalog = new Map(state.signals.map((signal) => [signal.name, signal]));
  return rows.map((row) => {
    const stored = catalog.get(row.name);
    if (stored === undefined || stored.unit_source === null) return row;
    if (sourceRank(stored.unit_source) <= sourceRank(row.unit_source)) return row;
    return { ...row, unit: stored.unit, unit_source: stored.unit_source };
  });
}

export function listRunSignals(state: MockState, runId: string, pagination: Pagination): Paginated<FileSignal> {
  const run = requireRun(state, runId);
  const page = paginate(mergedRunSignals(state, runId), pagination, run.signal_count);
  return { ...page, items: withWinningUnits(state, page.items) };
}

export function getRunJournal(
  state: MockState,
  runId: string,
  kind: JournalKind | undefined,
  pagination: Pagination,
): Paginated<JournalEntry> {
  requireRun(state, runId);
  let entries = runJournalEntries(state, runId);
  if (kind) entries = entries.filter((j) => j.kind === kind);
  entries = [...entries].sort((a, b) => b.at.localeCompare(a.at));
  return paginate(entries.map(toJournalEntry), pagination);
}

/**
 * The five entity journals of contract §8b.
 *
 * The run has its own read above, because a run's timeline also unions the
 * edits made in its context. These five read one entity each, and they serve
 * the shape §8 serves: the same `kind` filter, the same default page size and
 * the same `at`-descending order.
 *
 * The id must name a document. A mistyped id answers 404 and never an empty
 * page, so an empty page means "nothing happened yet" and nothing else.
 */
type JournalledEntity = Exclude<JournalEntityType, "run">;

function requireEntity(state: MockState, entityType: JournalledEntity, entityId: string): void {
  if (entityType === "file") {
    if (!state.files.some((f) => f.file_id === entityId)) {
      throw notFound("file_not_found", `File ${entityId} not found`);
    }
    return;
  }
  if (entityType === "signal") {
    requireSignal(state, entityId);
    return;
  }
  if (entityType === "work_order") {
    if (!mirroredWorkOrders(state).some((w) => w.wo_id === entityId)) {
      throw notFound("wo_not_found", `Work order ${entityId} not found`);
    }
    return;
  }
  if (entityType === "test_definition") {
    // An unmirrored definition is one the detail read refuses too, so both
    // reads answer 404 on the same id.
    if (!state.definitions.some((d) => d.td_id === entityId && d.mirrored)) {
      throw notFound("td_not_found", `Test definition ${entityId} not found`);
    }
    return;
  }
  if (!state.results.some((r) => r.result_id === entityId)) {
    throw notFound("result_not_found", `Result ${entityId} not found`);
  }
}

export function getEntityJournal(
  state: MockState,
  entityType: JournalledEntity,
  entityId: string,
  kind: JournalKind | undefined,
  pagination: Pagination,
): Paginated<JournalEntry> {
  requireEntity(state, entityType, entityId);
  let entries = state.journal.filter(
    (j) => j.entity_type === entityType && j.entity_id === entityId,
  );
  if (kind) entries = entries.filter((j) => j.kind === kind);
  entries = [...entries].sort((a, b) => b.at.localeCompare(a.at));
  return paginate(entries.map(toJournalEntry), pagination);
}

/**
 * The cross-entity journal read (FR-DM-055) — `GET /journal`.
 *
 * Mirrors `api/api/routers/journal.py list_journal`: every filter is optional,
 * the filters combine with AND, the five string filters match exactly, the two
 * bounds on `at` are inclusive, and the page reads `at`-descending.
 *
 * It checks no entity id. A read of the whole journal has nothing to check
 * against, so an unknown id matches nothing and answers an empty page.
 */
export interface GlobalJournalFilters {
  entity_type?: JournalEntityType;
  entity_id?: string;
  field?: string;
  actor?: string;
  kind?: JournalKind;
  since?: string;
  until?: string;
}

export function getGlobalJournal(
  state: MockState,
  filters: GlobalJournalFilters,
  pagination: Pagination,
): Paginated<JournalEntry> {
  let entries = state.journal;
  if (filters.entity_type) entries = entries.filter((j) => j.entity_type === filters.entity_type);
  if (filters.entity_id) entries = entries.filter((j) => j.entity_id === filters.entity_id);
  if (filters.field) entries = entries.filter((j) => j.field === filters.field);
  if (filters.actor) entries = entries.filter((j) => j.actor === filters.actor);
  if (filters.kind) entries = entries.filter((j) => j.kind === filters.kind);
  /* The bounds compare as moments, not as text. A caller may send a bare
     date, and a bare date sorts before every stamp of that same day. */
  if (filters.since) {
    const since = Date.parse(filters.since);
    entries = entries.filter((j) => Date.parse(j.at) >= since);
  }
  if (filters.until) {
    const until = Date.parse(filters.until);
    entries = entries.filter((j) => Date.parse(j.at) <= until);
  }
  entries = [...entries].sort((a, b) => b.at.localeCompare(a.at));
  return paginate(entries.map(toJournalEntry), pagination);
}

const JOURNAL_ENTITY_TYPES: readonly JournalEntityType[] = [
  "run",
  "file",
  "signal",
  "work_order",
  "result",
  "test_definition",
  "export",
];

/**
 * `POST /journal` (★) — one event on any entity; the ingestion watcher's
 * narration route. Mirrors `api/api/routers/journal.py add_journal_event`:
 * every entity type takes the existence check (an appended entry can never
 * be removed, so this is the one chance to refuse a ghost), the caller's
 * `at` is KEPT (it is the moment the step happened, not the call), and the
 * kind is pinned to "event".
 */
/**
 * The one field name every access request carries. A reviewer reads the whole
 * queue with `GET /journal?field=access.requested`, so the API and this mock
 * must state the same string.
 */
export const ACCESS_REQUEST_FIELD = "access.requested";

export function addJournalEvent(state: MockState, body: Record<string, unknown>): JournalEntry {
  const entityType = body.entity_type;
  if (!JOURNAL_ENTITY_TYPES.includes(entityType as JournalEntityType)) {
    throw validation("validation_error", "entity_type must name a journalled entity", [
      { loc: ["body", "entity_type"], msg: `must be one of ${JOURNAL_ENTITY_TYPES.join(", ")}`, type: "value_error" },
    ]);
  }
  const entityId = typeof body.entity_id === "string" ? body.entity_id : "";
  if (entityType === "run") requireRun(state, entityId);
  else requireEntity(state, entityType as JournalledEntity, entityId);

  if (typeof body.field !== "string" || body.field.length === 0) {
    throw validation("validation_error", "field is required", [
      { loc: ["body", "field"], msg: "field required", type: "value_error.missing" },
    ]);
  }
  if (body.kind !== "event") {
    throw validation("validation_error", 'kind must be "event"', [
      { loc: ["body", "kind"], msg: 'must be "event"', type: "value_error" },
    ]);
  }
  const source = body.source;
  const validSource =
    source === "embedded" || source === "manual" || (typeof source === "string" && source.startsWith("api:"));
  if (!validSource) {
    throw validation("validation_error", "source must be a valid source tag", [
      { loc: ["body", "source"], msg: "must be embedded, manual or api:*", type: "value_error" },
    ]);
  }
  const actor = requireBodyActor(body.actor);
  if (typeof body.at !== "string" || Number.isNaN(Date.parse(body.at))) {
    throw validation("validation_error", "at must be an ISO date-time", [
      { loc: ["body", "at"], msg: "invalid datetime", type: "value_error" },
    ]);
  }
  const record: JournalRecord = {
    id: `j-${crypto.randomUUID()}`,
    entity_type: entityType as JournalEntityType,
    entity_id: entityId,
    field: body.field,
    kind: "event",
    old: null,
    new: null,
    source: source as SourceTag,
    actor,
    note: typeof body.note === "string" ? body.note : null,
    at: body.at,
  };
  state.journal.push(record);
  return toJournalEntry(record);
}

/**
 * Record a request for access to one entity — `POST /access-requests` (§D-Access).
 *
 * **The registry grants nothing**, here or in the real API. It writes one
 * journal event with the field `access.requested` and the stated reason as the
 * note, and a person acts on it outside the system. The rules are copied from
 * `api/api/routers/journal.py`: the entity must exist, the actor must name
 * somebody, and the reason must not be blank.
 */
export function requestAccess(state: MockState, body: Record<string, unknown>): JournalEntry {
  const entityType = body.entity_type;
  if (!JOURNAL_ENTITY_TYPES.includes(entityType as JournalEntityType)) {
    throw validation("validation_error", "entity_type must name a journalled entity", [
      { loc: ["body", "entity_type"], msg: `must be one of ${JOURNAL_ENTITY_TYPES.join(", ")}`, type: "value_error" },
    ]);
  }
  const entityId = typeof body.entity_id === "string" ? body.entity_id : "";
  if (entityType === "run") requireRun(state, entityId);
  else requireEntity(state, entityType as JournalledEntity, entityId);

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length === 0 || reason.length > 1000) {
    throw validation("validation_error", "reason must hold 1 to 1000 characters", [
      { loc: ["body", "reason"], msg: "must hold 1 to 1000 characters", type: "value_error" },
    ]);
  }
  const actor = requireBodyActor(body.actor);
  const now = new Date().toISOString();
  const record: JournalRecord = {
    id: `j-${crypto.randomUUID()}`,
    entity_type: entityType as JournalEntityType,
    entity_id: entityId,
    field: ACCESS_REQUEST_FIELD,
    kind: "event",
    old: null,
    new: null,
    source: "manual",
    actor,
    note: reason,
    at: now,
  };
  state.journal.push(record);
  return toJournalEntry(record);
}

export function getRunLineage(state: MockState, runId: string): LineageResponse {
  const run = requireRun(state, runId);
  const wo = run.work_order_id
    ? state.workOrders.find((w) => w.wo_id === run.work_order_id && w.mirrored)
    : undefined;
  const def = run.definition_id
    ? state.definitions.find((d) => d.td_id === run.definition_id && d.mirrored)
    : undefined;
  return {
    work_order: wo ? { wo_id: wo.wo_id, title: wo.title, project: wo.project, source: "api:planning" } : null,
    definition: def ? { td_id: def.td_id, title: def.title, source: "api:planning" } : null,
    run: {
      run_id: run.run_id,
      rig_id: run.rig_id,
      test_cell: run.test_cell,
      first_data_at: run.first_data_at,
      file_count: run.file_count,
      signal_count: run.signal_count,
      status: runStatus(run),
    },
    files: state.files
      .filter((f) => f.run_id === runId)
      .map((f) => ({
        file_id: f.file_id,
        filename: f.filename,
        source_system: f.source_system,
        size_bytes: f.size_bytes,
        signal_count: f.signal_count,
      })),
    results: state.results
      .filter((r) => r.run_id === runId)
      .map((r) => ({
        result_id: r.result_id,
        name: r.name,
        version: r.version,
        provenance_status: r.provenance_status,
        provenance: r.provenance,
      })),
  };
}

function mirroredWorkOrders(state: MockState): WorkOrderRecord[] {
  return state.workOrders.filter((w) => w.mirrored);
}

function woRuns(state: MockState, woId: string): RunRecord[] {
  return state.runs
    .filter((r) => r.work_order_id === woId)
    .sort((a, b) => b.first_data_at.localeCompare(a.first_data_at));
}

function woDefinitionCount(state: MockState, woId: string): number {
  return state.woDefinitions.filter((l) => l.wo_id === woId).length;
}

function toWorkOrderListItem(state: MockState, wo: WorkOrderRecord): WorkOrderListItem {
  return {
    wo_id: wo.wo_id,
    title: wo.title,
    project: wo.project,
    status: wo.status,
    definition_count: woDefinitionCount(state, wo.wo_id),
    run_count: woRuns(state, wo.wo_id).length,
    synced_at: wo.synced_at,
  };
}

/** Whole-table quick-view counts for /work-orders — filter-independent. */
export function workOrdersViewCounts(
  state: MockState,
): { all: number; active: number; closed: number } {
  const all = mirroredWorkOrders(state);
  return {
    all: all.length,
    active: all.filter((w) => w.status === "active").length,
    closed: all.filter((w) => w.status === "closed").length,
  };
}

/**
 * The distinct project values of the whole mirror — contract §10b. Sorted
 * ascending, blanks dropped.
 */
export function workOrderFacets(state: MockState): WorkOrderFacets {
  const projects = new Set<string>();
  for (const wo of mirroredWorkOrders(state)) {
    if (wo.project.trim() !== "") projects.add(wo.project);
  }
  return { projects: [...projects].sort() };
}

export function listWorkOrders(
  state: MockState,
  filters: WorkOrderListFilters,
  pagination: Pagination,
): WorkOrderListResponse {
  let workOrders = [...mirroredWorkOrders(state)].sort((a, b) => b.wo_id.localeCompare(a.wo_id));
  if (filters.status && filters.status.length > 0) {
    const set = new Set(filters.status);
    workOrders = workOrders.filter((w) => set.has(w.status));
  }
  if (filters.project && filters.project.length > 0) {
    const set = new Set(filters.project);
    workOrders = workOrders.filter((w) => set.has(w.project));
  }
  if (filters.q) {
    const rx = searchRegex(filters.q);
    workOrders = workOrders.filter((w) => rx.test(w.wo_id) || rx.test(w.title) || rx.test(w.project));
  }
  return {
    ...paginate(workOrders.map((w) => toWorkOrderListItem(state, w)), pagination),
    view_counts: workOrdersViewCounts(state),
  };
}

export function getWorkOrder(state: MockState, woId: string): WorkOrderDetail {
  const wo = mirroredWorkOrders(state).find((w) => w.wo_id === woId);
  if (!wo) throw notFound("wo_not_found", `Work order ${woId} not found`);
  const runs = woRuns(state, woId);
  return {
    wo_id: wo.wo_id,
    title: wo.title,
    project: wo.project,
    status: wo.status,
    requestor: wo.requestor,
    department: wo.department,
    priority: wo.priority,
    created_at_source: wo.created_at_source,
    synced_at: wo.synced_at,
    definitions: state.woDefinitions
      .filter((l) => l.wo_id === woId)
      .map((l) => {
        const def = state.definitions.find((d) => d.td_id === l.td_id);
        const actual = runs.filter((r) => r.definition_id === l.td_id).length;
        return {
          td_id: l.td_id,
          title: def?.title ?? l.td_id,
          planned_runs: l.planned_runs,
          actual_runs: actual,
          status: actual >= l.planned_runs ? ("on_plan" as const) : ("awaiting_data" as const),
        };
      }),
    runs: runs.map((r) => ({
      run_id: r.run_id,
      definition_id: r.definition_id,
      rig_id: r.rig_id,
      test_cell: r.test_cell,
      first_data_at: r.first_data_at,
      file_count: r.file_count,
      signal_count: r.signal_count,
      status: runStatus(r),
    })),
  };
}

export const FILES_SORT_WHITELIST = ["registered_at", "size_bytes"] as const;
export const FILES_SORT_DEFAULTS: Readonly<Record<(typeof FILES_SORT_WHITELIST)[number], SortOrder>> =
  { registered_at: "desc", size_bytes: "desc" };

function compareFilesBy(
  key: (typeof FILES_SORT_WHITELIST)[number],
  order: SortOrder,
): (a: FileRecord, b: FileRecord) => number {
  const dir = order === "asc" ? 1 : -1;
  switch (key) {
    case "registered_at":
      return (a, b) => a.registered_at.localeCompare(b.registered_at) * dir;
    case "size_bytes":
      return (a, b) => (a.size_bytes - b.size_bytes) * dir;
  }
}

/** Whole-table quick-view counts for /files — filter-independent. */
export function filesViewCounts(state: MockState): FileViewCounts {
  // The backend counts `all`, `registered` and `quarantined` over the files
  // nobody deleted, and reports the two lifecycle views beside them
  // (api/api/services/queries_signals.py). Every seeded row is active (no
  // lifecycle field, like a pre-20-Aug-2026 document), so the two views
  // start at 0 — but the mock lifecycle routes write the field now, so the
  // counts must read it.
  const undeleted = state.files.filter((f) => fileLifecycle(f) !== "deleted");
  return {
    all: undeleted.length,
    registered: undeleted.filter((f) => f.status === "registered").length,
    quarantined: undeleted.filter((f) => f.status === "quarantined").length,
    archived: state.files.filter((f) => fileLifecycle(f) === "archived").length,
    deleted: state.files.filter((f) => fileLifecycle(f) === "deleted").length,
  };
}

export function listFiles(
  state: MockState,
  filters: FileListFilters,
  pagination: Pagination,
  sort: ParsedSort<(typeof FILES_SORT_WHITELIST)[number]> = {
    key: "registered_at",
    order: FILES_SORT_DEFAULTS.registered_at,
  },
): FileListResponse {
  let files = [...state.files].sort(compareFilesBy(sort.key, sort.order));
  if (filters.status && filters.status.length > 0) {
    const set = new Set(filters.status);
    files = files.filter((f) => set.has(f.status));
  }
  if (filters.source_system && filters.source_system.length > 0) {
    const set = new Set(filters.source_system);
    files = files.filter((f) => set.has(f.source_system));
  }
  // No named view asks for the plain table, which holds the active files
  // only — an archived and a deleted file both stay out of it, the same rule
  // `api/api/routers/files.py` applies.
  const lifecycleViews = filters.lifecycle ?? ["active"];
  files = files.filter((f) => lifecycleViews.includes(fileLifecycle(f)));
  if (filters.run) files = files.filter((f) => f.run_id === filters.run);
  // `invalid=true` serves the marked files, `invalid=false` serves the rest,
  // and no value serves both — the mark hides no row (`files.py list_files`).
  if (filters.invalid !== undefined) {
    files = files.filter((f) => fileInvalid(f).flagged === filters.invalid);
  }
  if (filters.unlinked !== undefined) {
    files = files.filter((f) => (filters.unlinked ? f.run_id === null : f.run_id !== null));
  }
  if (filters.q) {
    const rx = searchRegex(filters.q);
    files = files.filter((f) => rx.test(f.filename) || rx.test(f.checksum_sha256) || rx.test(f.run_id ?? ""));
  }
  return {
    ...paginate(files.map(toFileEntity), pagination),
    view_counts: filesViewCounts(state),
  };
}

export function getFile(state: MockState, fileId: string, signalsLimit: number): FileDetail {
  const file = requireFile(state, fileId);
  const timeline = state.journal
    .filter((j) => j.entity_type === "file" && j.entity_id === fileId)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(toJournalEntry);
  return {
    ...toFileEntity(file),
    storage_ref: file.storage_ref,
    ingestion_job_id: file.ingestion_job_id,
    field_sources: file.field_sources,
    ingestion_timeline: timeline,
    signals: (state.fileSignals[fileId] ?? []).slice(0, signalsLimit),
    supersedes: file.supersedes ?? null,
  };
}

/* ─────────────── File write routes (M1 — mock parity, 20 Aug 2026 API) ───────────────
 *
 * These mirror `api/api/routers/files.py` closely enough for the e2e rig and
 * a demo room: same status codes, same error codes, same journal fields.
 * What they deliberately skip: the compare-and-set race guard (one process,
 * no races) and the full registration pipeline (a version mints a minimal
 * record, not a re-run of ingestion).
 */

function requireBodyActor(actor: unknown): string {
  if (typeof actor !== "string" || actor.trim().length === 0) {
    throw validation("validation_error", "actor is required", [
      { loc: ["body", "actor"], msg: "field required", type: "value_error.missing" },
    ]);
  }
  return actor;
}

/** Refuse an edit/version on a file that left the active table (409). */
function requireActiveFile(state: MockState, fileId: string, verb: string): FileRecord {
  const file = requireFile(state, fileId);
  const lifecycle = fileLifecycle(file);
  if (lifecycle !== "active") {
    const code = lifecycle === "deleted" ? "file_deleted" : "file_archived";
    throw new MockDbError(409, code, `File ${fileId} is ${lifecycle}. Restore it before you ${verb} it.`);
  }
  return file;
}

/** Move one file to a lifecycle value and journal the step, like `_write_lifecycle`. */
function writeFileLifecycle(
  state: MockState,
  file: FileRecord,
  value: "active" | "archived" | "deleted",
  eventField: string,
  actor: string,
  note: unknown,
): void {
  const at = nowIso();
  file.lifecycle = value;
  file.field_sources.lifecycle = { source: "manual", actor, at };
  state.journal.push({
    id: `j-${crypto.randomUUID()}`,
    entity_type: "file",
    entity_id: file.file_id,
    field: eventField,
    kind: "event",
    old: null,
    new: null,
    source: "manual",
    actor,
    note: typeof note === "string" ? note : null,
    at,
  });
}

/** `POST /files/{id}/archive`. Idempotent; a deleted file refuses with 409. */
export function archiveFile(state: MockState, fileId: string, actor: unknown, note: unknown): FileDetail {
  const actorName = requireBodyActor(actor);
  const file = requireFile(state, fileId);
  const lifecycle = fileLifecycle(file);
  if (lifecycle === "deleted") {
    throw new MockDbError(409, "file_deleted", `File ${fileId} is deleted. Restore it before you archive it.`);
  }
  if (lifecycle !== "archived") writeFileLifecycle(state, file, "archived", "file.archived", actorName, note);
  return getFile(state, fileId, 200);
}

/** `POST /files/{id}/restore`. Never touches `status` — quarantine survives. */
export function restoreFile(state: MockState, fileId: string, actor: unknown, note: unknown): FileDetail {
  const actorName = requireBodyActor(actor);
  const file = requireFile(state, fileId);
  if (fileLifecycle(file) !== "active") {
    writeFileLifecycle(state, file, "active", "file.restored", actorName, note);
  }
  return getFile(state, fileId, 200);
}

/** `DELETE /files/{id}` — a SOFT delete: every byte and field stays. Idempotent. */
export function softDeleteFile(state: MockState, fileId: string, actor: unknown, note: unknown): FileDetail {
  const actorName = requireBodyActor(actor);
  const file = requireFile(state, fileId);
  if (fileLifecycle(file) !== "deleted") {
    writeFileLifecycle(state, file, "deleted", "file.deleted", actorName, note);
  }
  return getFile(state, fileId, 200);
}

/* ─────────────── The file-level invalid mark (24 Aug 2026 API) ───────────────
 *
 * `POST /files/{id}/invalid-flag` and `DELETE /files/{id}/invalid-flag`, read
 * from `api/api/routers/files.py` (`flag_file_invalid`, `clear_file_invalid`,
 * `_write_invalid_flag`). It is the run mark of the same name at file level,
 * and the two marks stay separate judgments: this write touches the file and
 * nothing else. It never moves `status`, it never counts the file out of a
 * rollup, and it never reaches the run.
 *
 * One deviation from `flagInvalid` above, on purpose: the reason check runs
 * BEFORE the 404. The real body is a pydantic model, so its `reason_required`
 * validator answers 422 before the route ever loads the file. The run lane
 * checks the id first, and copying that here would answer 404 where the real
 * API answers 422.
 */

/** The 422 the real `FileInvalidFlagRequest` raises — one message, both routes. */
function requireFlagReason(reason: unknown): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length === 0) {
    throw validation("reason_required", "A reason is required to flag a file invalid", [
      { loc: ["body", "reason"], msg: "must be a non-empty string", type: "value_error" },
    ]);
  }
  return trimmed;
}

/** Store one side of the mark and journal the judgment — `_write_invalid_flag`. */
function writeFileInvalidFlag(
  state: MockState,
  file: FileRecord,
  flagged: boolean,
  reason: string,
  actor: string,
): void {
  const at = nowIso();
  file.invalid = {
    flagged,
    reason: flagged ? reason : null,
    actor: flagged ? actor : null,
    at: flagged ? at : null,
  };
  file.field_sources.invalid = { source: "manual", actor, at };
  state.journal.push({
    id: `j-${crypto.randomUUID()}`,
    entity_type: "file",
    entity_id: file.file_id,
    field: "file.invalid_flag",
    kind: "change",
    // Contract #5 shows the flag state in the timeline: false → true, and back.
    old: flagged ? "false" : "true",
    new: flagged ? "true" : "false",
    source: "manual",
    actor,
    note: reason,
    at,
  });
}

/**
 * `POST /files/{id}/invalid-flag` — mark one file invalid. A repeat answers
 * 409 `already_flagged`, and the first reason stays the one a reader sees.
 */
export function flagFileInvalid(
  state: MockState,
  fileId: string,
  reason: unknown,
  actor: unknown,
): FileDetail {
  const trimmed = requireFlagReason(reason);
  const actorName = requireBodyActor(actor);
  const file = requireFile(state, fileId);
  if (fileInvalid(file).flagged) {
    throw new MockDbError(409, "already_flagged", `File ${fileId} is already flagged invalid`);
  }
  writeFileInvalidFlag(state, file, true, trimmed, actorName);
  return getFile(state, fileId, 200);
}

/**
 * `DELETE /files/{id}/invalid-flag` — undo the mark. The reason stays
 * required, and a file nobody marked answers 409 `not_flagged`.
 */
export function clearFileInvalidFlag(
  state: MockState,
  fileId: string,
  reason: unknown,
  actor: unknown,
): FileDetail {
  const trimmed = requireFlagReason(reason);
  const actorName = requireBodyActor(actor);
  const file = requireFile(state, fileId);
  if (!fileInvalid(file).flagged) {
    throw new MockDbError(409, "not_flagged", `File ${fileId} is not flagged invalid`);
  }
  writeFileInvalidFlag(state, file, false, trimmed, actorName);
  return getFile(state, fileId, 200);
}

/** The one quarantine reason a run link repairs — `files.py _MISSING_LINK_REASON`. */
const MISSING_LINK_REASON = "no run key";

/** Fields `PATCH /files/{id}` may write, beside the run link. */
const FILE_STAGE_FIELDS = ["sync_status", "upload_status", "conversion_status", "stage_error"] as const;
const STAGE_STATUSES = ["pending", "in_progress", "success", "failed"] as const;

/** Adjust a run's stored counts when a file joins or leaves it. */
function adjustRunCounts(state: MockState, runId: string, file: FileRecord, direction: 1 | -1): void {
  const run = state.runs.find((r) => r.run_id === runId);
  if (run === undefined) return;
  run.file_count = Math.max(0, run.file_count + direction);
  run.signal_count = Math.max(0, run.signal_count + direction * file.signal_count);
}

/**
 * `PATCH /files/{id}` — the manual run link and the stage outcomes.
 *
 * Mirrors the real route's rules: null counts as absent; no fields → 400;
 * an archived/deleted file → 409; an unknown run → 422 `unknown_run`; a
 * run link ends the quarantine ONLY when the missing link was the reason
 * ("no run key") and the checksum does not say mismatch; a stage outcome
 * never ends a quarantine.
 */
export function patchFile(state: MockState, fileId: string, body: Record<string, unknown>): FileDetail {
  const actor = requireBodyActor(body.actor);
  const note = typeof body.note === "string" ? body.note : null;
  const changes: Record<string, unknown> = {};
  for (const key of ["run_id", ...FILE_STAGE_FIELDS]) {
    if (body[key] !== undefined && body[key] !== null) changes[key] = body[key];
  }
  if (Object.keys(changes).length === 0) {
    throw new MockDbError(400, "no_fields_to_update", "no fields to update");
  }
  const file = requireActiveFile(state, fileId, "edit");

  const at = nowIso();
  if (typeof changes.run_id === "string") {
    const runId = changes.run_id;
    if (!state.runs.some((r) => r.run_id === runId)) {
      throw validation("unknown_run", `No run ${runId} is registered here`);
    }
    const oldRunId = file.run_id;
    if (oldRunId !== runId) {
      file.run_id = runId;
      file.field_sources.run_id = { source: "manual", actor, at };
      state.journal.push({
        id: `j-${crypto.randomUUID()}`,
        entity_type: "file",
        entity_id: fileId,
        field: "file.run",
        kind: "change",
        old: oldRunId ?? "(empty)",
        new: runId,
        source: "manual",
        actor,
        note,
        at,
        // The run's journal unions entries that name it as context, so the
        // run timeline shows the file that joined it (contract §8).
        context_run_id: runId,
      });
      // The stored counts follow the moved file, a light stand-in for the
      // real rollup.
      adjustRunCounts(state, runId, file, 1);
      if (oldRunId !== null) adjustRunCounts(state, oldRunId, file, -1);
    }
    // An unchanged id still repairs: the file KEPT the key it could not
    // resolve, so re-stating it after the run lands ends the quarantine.
    const repairable =
      file.status === "quarantined" &&
      file.checksum_state !== "mismatch" &&
      file.quarantine_reason === MISSING_LINK_REASON;
    if (repairable) {
      file.status = "registered";
      file.quarantine_reason = null;
      state.journal.push({
        id: `j-${crypto.randomUUID()}`,
        entity_type: "file",
        entity_id: fileId,
        field: "file.unquarantined",
        kind: "event",
        old: null,
        new: null,
        source: "manual",
        actor,
        note: `Linked to run ${runId}. The file leaves quarantine.`,
        at,
      });
    }
  }

  for (const field of FILE_STAGE_FIELDS) {
    if (!(field in changes)) continue;
    const raw = changes[field];
    if (typeof raw !== "string") {
      throw validation("validation_error", `${field} must be a string`, [
        { loc: ["body", field], msg: "must be a string", type: "value_error" },
      ]);
    }
    if (field !== "stage_error" && !STAGE_STATUSES.includes(raw as StageStatus)) {
      throw validation("validation_error", `${field} must name a stage status`, [
        { loc: ["body", field], msg: `must be one of ${STAGE_STATUSES.join(", ")}`, type: "value_error" },
      ]);
    }
    const next = raw;
    const prev = file[field] ?? null;
    // A repeated report writes nothing — no "success → success" rows.
    if (prev === next) continue;
    if (field === "stage_error") file.stage_error = next;
    else file[field] = next as StageStatus;
    file.field_sources[field] = { source: "manual", actor, at };
    state.journal.push({
      id: `j-${crypto.randomUUID()}`,
      entity_type: "file",
      entity_id: fileId,
      field: `file.${field}`,
      kind: "change",
      old: prev === null ? "(empty)" : String(prev),
      new: String(next),
      source: "manual",
      actor,
      note,
      at,
    });
  }

  return getFile(state, fileId, 200);
}

/** The chain one file belongs to — a record without the field roots its own. */
function fileVersionGroup(file: FileRecord): string {
  return file.version_group ?? file.file_id;
}

function fileChain(state: MockState, groupId: string): FileRecord[] {
  return state.files
    .filter((f) => f.file_id === groupId || f.version_group === groupId)
    .sort(
      (a, b) => (a.version ?? 1) - (b.version ?? 1) || a.registered_at.localeCompare(b.registered_at),
    );
}

/**
 * `GET /files/{id}/versions` — the whole chain, oldest first. Every
 * lifecycle shows: the history is the audit trail, and a gap would hide a
 * step. The plain files table still hides a deleted file.
 */
export function listFileVersions(state: MockState, fileId: string): ItemsEnvelope<FileEntity> {
  const groupId = fileVersionGroup(requireFile(state, fileId));
  const items = fileChain(state, groupId).map(toFileEntity);
  return { items, total: items.length };
}

/** The answer of `registerFileVersion` — `replayed` steers 200 vs 201. */
export interface FileVersionRegistration {
  file: FileEntity;
  replayed: boolean;
}

/**
 * `POST /files/{id}/versions` — append a whole new file to the chain.
 *
 * Mirrors the real route's visible rules: any version of the chain may be
 * named; an archived/deleted anchor refuses with 409; a body whose checksum
 * matches the newest version REPLAYS (200, nothing written); a body naming
 * no run inherits the newest version's run. The mock mints a minimal record
 * rather than re-running registration.
 */
export function registerFileVersion(
  state: MockState,
  fileId: string,
  body: Record<string, unknown>,
): FileVersionRegistration {
  const actor = requireBodyActor(body.actor);
  if (typeof body.filename !== "string" || body.filename.trim().length === 0) {
    throw validation("validation_error", "filename is required", [
      { loc: ["body", "filename"], msg: "field required", type: "value_error.missing" },
    ]);
  }
  const anchor = requireActiveFile(state, fileId, "version");
  const groupId = fileVersionGroup(anchor);
  const chain = fileChain(state, groupId);
  const latest = chain[chain.length - 1] ?? anchor;

  const checksum = typeof body.checksum_sha256 === "string" ? body.checksum_sha256 : "";
  if (checksum.length > 0 && latest.checksum_sha256 === checksum) {
    // The newest version already carries these bytes — answer it, write nothing.
    return { file: toFileEntity(latest), replayed: true };
  }

  const version = (latest.version ?? 1) + 1;
  const runId = typeof body.run_id === "string" ? body.run_id : latest.run_id;
  const runExists = runId !== null && state.runs.some((r) => r.run_id === runId);
  const at = nowIso();
  const sourceSystem = body.source_system;
  const record: FileRecord = {
    file_id: newId("f"),
    filename: body.filename,
    run_id: runExists ? runId : null,
    source_system:
      sourceSystem === "TAS" || sourceSystem === "INCA" || sourceSystem === "ifile" || sourceSystem === "api"
        ? sourceSystem
        : "api",
    format: typeof body.format === "string" ? body.format : latest.format,
    size_bytes: typeof body.size_bytes === "number" ? body.size_bytes : 0,
    checksum_sha256: checksum,
    checksum_state:
      body.checksum_state === "verified" || body.checksum_state === "mismatch"
        ? body.checksum_state
        : "unverified",
    // The quarantine rules apply unchanged: a version that resolves no run
    // is kept, quarantined for the missing link — never dropped.
    status: runExists ? "registered" : "quarantined",
    quarantine_reason: runExists ? null : MISSING_LINK_REASON,
    signal_count: 0,
    time_start: latest.time_start,
    time_end: latest.time_end,
    registered_at: at,
    storage_ref:
      typeof body.storage_ref === "string"
        ? body.storage_ref
        : `blob://test-manager/uploads/${encodeURIComponent(body.filename)}`,
    ingestion_job_id: `ing-mock-${version}-${groupId}`,
    field_sources: {
      filename: { source: "manual", actor, at },
      run_id: { source: "manual", actor, at },
    },
    lifecycle: "active",
    version,
    version_group: groupId,
    supersedes: latest.file_id,
  };
  state.files.push(record);
  if (record.run_id !== null) adjustRunCounts(state, record.run_id, record, 1);

  let note = `Version ${version} supersedes file ${latest.file_id}.`;
  if (typeof body.note === "string" && body.note.length > 0) note = `${note} ${body.note}`;
  state.journal.push({
    id: `j-${crypto.randomUUID()}`,
    entity_type: "file",
    entity_id: record.file_id,
    field: "file.version_registered",
    kind: "event",
    old: null,
    new: null,
    source: "manual",
    actor,
    note,
    at,
  });
  return { file: toFileEntity(record), replayed: false };
}

/**
 * Download outcome for the mock file-download route (contract v1.1 §D).
 *
 * The mock never streams real bytes — it returns a small deterministic body
 * whose contents are clearly labeled as a demo placeholder (see
 * `app/api/v1/files/[fileId]/download/route.ts`). The caller writes the
 * `file.downloaded` journal event **before** the bytes leave the handler
 * (audit-before-bytes), mirroring the BE rule.
 */
export interface DownloadPreparation {
  file: FileRecord;
  audit: JournalRecord;
}

/**
 * Prepare a mock download: run the same permission checks the BE runs, then
 * append the audit journal entry **before** any bytes are returned. Returns
 * the file record and the appended entry so the route handler can build the
 * response headers (Content-Disposition, X-Checksum-SHA256, X-Journal-Id).
 *
 * Throws:
 *  - `file_not_found` (404) — unknown id
 *  - `not_allowed` (403) — quarantined file (contract §D box)
 *
 * The mock never fails the audit write (there is no persistence layer to
 * fail), so there is no 503 path here.
 */
export function prepareDownload(state: MockState, fileId: string): DownloadPreparation {
  const file = state.files.find((f) => f.file_id === fileId);
  if (!file) throw notFound("file_not_found", `File ${fileId} not found`);
  if (file.status === "quarantined") {
    throw new MockDbError(
      403,
      "not_allowed",
      `File ${fileId} is quarantined and cannot be downloaded`,
    );
  }
  const at = nowIso();
  const audit: JournalRecord = {
    id: `j-${crypto.randomUUID()}`,
    entity_type: "file",
    entity_id: fileId,
    field: "file.downloaded",
    kind: "event",
    old: null,
    new: null,
    source: "embedded",
    actor: "static token holder",
    note: `Downloaded ${file.filename} (mock — deterministic payload)`,
    at,
  };
  state.journal.push(audit);
  return { file, audit };
}

function requireSignal(state: MockState, name: string): SignalRecord {
  const signal = state.signals.find((s) => s.name === name);
  if (!signal) throw notFound("signal_not_found", `Signal ${name} not found`);
  return signal;
}

/**
 * Every producing system that carried one signal — contract §15 (FR-DM-111).
 *
 * The mock derives the map the way the API's backfill derives it: a file row
 * names the signal, and the file names the system. Deriving beats storing it
 * on the seed rows, because the two would then drift apart.
 */
function sourceSystemIndex(state: MockState): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const file of state.files) {
    for (const signal of state.fileSignals[file.file_id] ?? []) {
      const systems = index.get(signal.name) ?? new Set<string>();
      systems.add(file.source_system);
      index.set(signal.name, systems);
    }
  }
  return index;
}

function sourceSystemsOf(state: MockState, name: string): string[] {
  return [...(sourceSystemIndex(state).get(name) ?? [])].sort();
}

function toSignalDetail(state: MockState, signal: SignalRecord): SignalDetail {
  return { ...signal, source_systems: sourceSystemsOf(state, signal.name) };
}

function toCatalogEntry(signal: SignalRecord) {
  const { sensor_ref: _s, catalogue_ref: _c, rig_ids: _r, field_sources: _f, ...entry } = signal;
  return entry;
}

export const SIGNALS_SORT_WHITELIST = [
  "name",
  "typical_rate_hz",
  "run_count",
  "last_seen",
] as const;
export const SIGNALS_SORT_DEFAULTS: Readonly<
  Record<(typeof SIGNALS_SORT_WHITELIST)[number], SortOrder>
> = { name: "asc", typical_rate_hz: "desc", run_count: "desc", last_seen: "desc" };

function compareSignalsBy(
  key: (typeof SIGNALS_SORT_WHITELIST)[number],
  order: SortOrder,
): (a: SignalRecord, b: SignalRecord) => number {
  const dir = order === "asc" ? 1 : -1;
  switch (key) {
    case "name":
      return (a, b) => a.name.localeCompare(b.name) * dir;
    case "typical_rate_hz":
      return (a, b) => (a.typical_rate_hz - b.typical_rate_hz) * dir;
    case "run_count":
      return (a, b) => (a.run_count - b.run_count) * dir;
    case "last_seen":
      return (a, b) => a.last_seen.localeCompare(b.last_seen) * dir;
  }
}

/** Whole-table quick-view counts for /signals — filter-independent. */
export function signalsViewCounts(state: MockState): { all: number; missing_unit: number } {
  return {
    all: state.signals.length,
    missing_unit: state.signals.filter((s) => s.unit === null).length,
  };
}

export function listSignals(
  state: MockState,
  filters: SignalListFilters,
  pagination: Pagination,
  sort: ParsedSort<(typeof SIGNALS_SORT_WHITELIST)[number]> = {
    key: "last_seen",
    order: SIGNALS_SORT_DEFAULTS.last_seen,
  },
): SignalListResponse {
  let signals = [...state.signals].sort(compareSignalsBy(sort.key, sort.order));
  if (filters.unit && filters.unit.length > 0) {
    const set = new Set(filters.unit);
    signals = signals.filter((s) => s.unit !== null && set.has(s.unit));
  }
  if (filters.missing_unit !== undefined) {
    signals = signals.filter((s) => (filters.missing_unit ? s.unit === null : s.unit !== null));
  }
  if (filters.rig && filters.rig.length > 0) {
    const set = new Set(filters.rig);
    signals = signals.filter((s) => s.rig_ids.some((r) => set.has(r)));
  }
  if (filters.rate && filters.rate.length > 0) {
    const set = new Set(filters.rate);
    signals = signals.filter((s) => set.has(s.typical_rate_hz));
  }
  if (filters.dtype && filters.dtype.length > 0) {
    const set = new Set(filters.dtype);
    signals = signals.filter((s) => set.has(s.dtype));
  }
  if (filters.source_system && filters.source_system.length > 0) {
    const wanted = new Set(filters.source_system);
    const index = sourceSystemIndex(state);
    signals = signals.filter((s) =>
      [...(index.get(s.name) ?? [])].some((system) => wanted.has(system)),
    );
  }
  if (filters.source && filters.source.length > 0) {
    // TR-011, the same rule the run list holds: the tag lives in the
    // `field_sources` map, so a signal matches when at least one of its fields
    // carries a named tag. An untagged signal matches nothing.
    const wanted = new Set<string>(filters.source);
    signals = signals.filter((s) =>
      Object.values(s.field_sources ?? {}).some((entry) => wanted.has(entry.source)),
    );
  }
  if (filters.q) {
    const rx = searchRegex(filters.q);
    signals = signals.filter((s) => rx.test(s.name) || rx.test(s.description));
  }
  return {
    ...paginate(signals.map(toCatalogEntry), pagination),
    view_counts: signalsViewCounts(state),
  };
}

/**
 * The distinct filter values of the whole catalog — contract §14b.
 * Each list sorts ascending. A null or blank unit is no unit option, because
 * `missing_unit` is the quick view that finds those rows.
 */
export function signalFacets(state: MockState): SignalFacets {
  const units = new Set<string>();
  const rates = new Set<number>();
  const rigs = new Set<string>();
  const dtypes = new Set<string>();
  const systems = new Set<string>();
  const index = sourceSystemIndex(state);
  for (const signal of state.signals) {
    if (signal.unit !== null && signal.unit.trim() !== "") units.add(signal.unit);
    if (Number.isFinite(signal.typical_rate_hz)) rates.add(signal.typical_rate_hz);
    for (const rig of signal.rig_ids) if (rig.trim() !== "") rigs.add(rig);
    if (signal.dtype.trim() !== "") dtypes.add(signal.dtype);
    for (const system of index.get(signal.name) ?? []) systems.add(system);
  }
  return {
    // Plain sort compares UTF-16 code units. Python `sorted` compares code
    // points. The two agree here, so the mock states the API order.
    units: [...units].sort(),
    rates: [...rates].sort((a, b) => a - b),
    rigs: [...rigs].sort(),
    dtypes: [...dtypes].sort(),
    source_systems: [...systems].sort(),
  };
}

export function getSignal(state: MockState, name: string): SignalDetail {
  return toSignalDetail(state, requireSignal(state, name));
}

const SIGNAL_PATCHABLE = ["unit", "description", "sensor_ref"] as const;

export function patchSignal(state: MockState, name: string, body: SignalPatchBody): SignalDetail {
  const signal = requireSignal(state, name);
  if (typeof body.actor !== "string" || body.actor.trim().length === 0) {
    throw validation("validation_error", "actor is required", [
      { loc: ["body", "actor"], msg: "field required", type: "value_error.missing" },
    ]);
  }
  const provided = SIGNAL_PATCHABLE.filter((f) => typeof body[f] === "string");
  if (provided.length === 0) {
    throw new MockDbError(400, "no_fields_to_update", "No patchable fields in request body");
  }
  if (body.context_run_id) requireRun(state, body.context_run_id);
  const at = nowIso();
  for (const field of provided) {
    const next = body[field] as string;
    const prev = signal[field];
    if (prev === next) continue;
    signal[field] = next;
    if (field === "unit") signal.unit_source = "manual";
    signal.field_sources[field] = { source: "manual", actor: body.actor, at };
    state.journal.push({
      id: `j-${crypto.randomUUID()}`,
      entity_type: "signal",
      entity_id: name,
      field: `signal.${name}.${field}`,
      kind: "change",
      old: prev ?? "(missing)",
      new: next,
      source: "manual",
      actor: body.actor,
      note: body.note ?? null,
      at,
      context_run_id: body.context_run_id,
    });
  }
  return toSignalDetail(state, signal);
}

export function getSignalRunStats(
  state: MockState,
  name: string,
  filters: SignalStatsFilters,
  pagination: Pagination,
): SignalRunStatsResponse {
  const signal = requireSignal(state, name);
  const stats = state.signalRunStats[name] ?? [];
  let rows = stats.flatMap((stat) => {
    const run = state.runs.find((r) => r.run_id === stat.run_id);
    if (!run) return [];
    return [
      {
        run_id: run.run_id,
        definition_id: run.definition_id,
        rig_id: run.rig_id,
        run_date: run.first_data_at.slice(0, 10),
        status: runStatus(run),
        min: stat.min,
        max: stat.max,
        mean: stat.mean,
        std: stat.std,
        first_data_at: run.first_data_at,
      },
    ];
  });
  if (filters.definition) rows = rows.filter((r) => r.definition_id === filters.definition);
  if (filters.rig) rows = rows.filter((r) => r.rig_id === filters.rig);
  if (!filters.include_invalid) rows = rows.filter((r) => r.status !== "invalid");
  rows.sort((a, b) => b.first_data_at.localeCompare(a.first_data_at));
  const page = paginate(
    rows.map(({ first_data_at: _f, ...row }) => row),
    pagination,
  );
  return { name: signal.name, unit: signal.unit, window: "run", ...page };
}

export function listResults(state: MockState, filters: ResultListFilters, pagination: Pagination): Paginated<ProcessedResult> {
  let results = [...state.results].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (filters.run) results = results.filter((r) => r.run_id === filters.run);
  if (filters.result_key) results = results.filter((r) => r.result_key === filters.result_key);
  if (filters.latest_only) {
    const latest = new Map<string, ProcessedResult>();
    for (const result of results) {
      const key = `${result.run_id}:${result.result_key}`;
      const existing = latest.get(key);
      if (!existing || result.version > existing.version) latest.set(key, result);
    }
    results = [...latest.values()];
  }
  return paginate(results, pagination);
}

/**
 * One result version, by its own id — the mock half of `GET /results/{id}`.
 * Throws `result_not_found` (404) for an unknown id.
 */
export function getResult(state: MockState, resultId: string): ProcessedResult {
  const result = state.results.find((r) => r.result_id === resultId);
  if (!result) throw notFound("result_not_found", `Result ${resultId} not found`);
  return result;
}

/** The keys of a result row a person may correct — `_PATCHABLE_FIELDS`. */
const RESULT_PATCH_FIELDS = ["name", "description"] as const;
const RESULT_BODY_KEYS = new Set(["name", "description", "provenance", "actor", "note"]);
const RESULT_PROVENANCE_KEYS = [
  "tool",
  "tool_version",
  "parameters",
  "input_file_ids",
  "produced_by",
  "produced_at",
] as const;
/** The actor strings that name nobody — `PLACEHOLDER_ACTORS` in the API. */
const PLACEHOLDER_ACTORS = new Set(["current-user", "unknown", "system", "null", "none", "user", "quix user"]);

/** True for a value the real `_is_blank` refuses. An empty list is not blank. */
function isBlankProvenance(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.some((entry) => entry === null || isBlankProvenance(entry));
  return false;
}

/** The 422 the real body model raises for a key it forbids (`extra="forbid"`). */
function refuseUnknownKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>, prefix: string): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw validation("validation_error", `${prefix}${key} is not a patchable field`, [
        { loc: ["body", `${prefix}${key}`], msg: "extra fields not permitted", type: "value_error.extra" },
      ]);
    }
  }
}

/** The 422 the shared `Actor` type raises for a name that names nobody. */
function requireNamedActor(actor: unknown, loc: string): string {
  const name = requireBodyActor(actor);
  if (PLACEHOLDER_ACTORS.has(name.trim().toLowerCase())) {
    throw validation("validation_error", `${loc} must name a person or a service`, [
      { loc: ["body", loc], msg: "must name a person or a service", type: "value_error" },
    ]);
  }
  return name;
}

/**
 * `PATCH /results/{result_id}` — correct the label or the provenance of one
 * stored result version. Mirrors `patch_result` in `api/api/routers/results.py`:
 * a null key counts as absent; a body 422 fires before the empty-body 400 and
 * before the 404; a value equal to the stored one writes nothing; each real
 * change writes one manual journal entry that also names the run; a changed
 * `input_file_ids` re-derives `provenance_status` without an entry of its own.
 * The identity keys (`run_id`, `version`, ...) refuse as unknown keys.
 */
export function patchResult(state: MockState, resultId: string, body: Record<string, unknown>): ProcessedResult {
  // The real body is a pydantic model, so it validates before the route runs.
  refuseUnknownKeys(body, RESULT_BODY_KEYS, "");
  const actor = requireNamedActor(body.actor, "actor");
  const note = typeof body.note === "string" ? body.note : null;

  const changes: Record<string, unknown> = {};
  for (const key of RESULT_PATCH_FIELDS) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw validation("validation_error", `${key} must be a string`, [
        { loc: ["body", key], msg: "must be a string", type: "value_error" },
      ]);
    }
    changes[key] = value;
  }

  if (body.provenance !== undefined && body.provenance !== null) {
    if (typeof body.provenance !== "object" || Array.isArray(body.provenance)) {
      throw validation("validation_error", "provenance must be an object", [
        { loc: ["body", "provenance"], msg: "must be an object", type: "value_error" },
      ]);
    }
    const block = body.provenance as Record<string, unknown>;
    refuseUnknownKeys(block, new Set(RESULT_PROVENANCE_KEYS), "provenance.");
    for (const key of RESULT_PROVENANCE_KEYS) {
      const value = block[key];
      if (value === undefined || value === null) continue;
      if (isBlankProvenance(value)) {
        throw validation("provenance_required", `provenance.${key} must not be blank`);
      }
      if (key === "input_file_ids") {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
          throw validation("validation_error", "provenance.input_file_ids must be a list of strings", [
            { loc: ["body", "provenance", key], msg: "must be a list of strings", type: "value_error" },
          ]);
        }
        changes[`provenance.${key}`] = value;
        continue;
      }
      if (typeof value !== "string") {
        throw validation("validation_error", `provenance.${key} must be a string`, [
          { loc: ["body", "provenance", key], msg: "must be a string", type: "value_error" },
        ]);
      }
      if (key === "produced_by") {
        changes[`provenance.${key}`] = requireNamedActor(value, "provenance.produced_by");
        continue;
      }
      if (key === "produced_at") {
        const instant = Date.parse(value);
        if (Number.isNaN(instant)) {
          throw validation("validation_error", "provenance.produced_at must be a datetime", [
            { loc: ["body", "provenance", key], msg: "must be a datetime", type: "value_error" },
          ]);
        }
        // Millisecond precision, like the real `_to_millis`, so a restatement
        // of the stored instant never journals a phantom change.
        changes[`provenance.${key}`] = new Date(instant).toISOString();
        continue;
      }
      changes[`provenance.${key}`] = value;
    }
  }

  if (Object.keys(changes).length === 0) {
    throw new MockDbError(400, "no_fields_to_update", "no fields to update");
  }

  const result = getResult(state, resultId);
  const provenance = result.provenance as unknown as Record<string, unknown>;
  const at = nowIso();
  let inputsChanged = false;
  const entries: JournalRecord[] = [];
  for (const [field, value] of Object.entries(changes)) {
    const dotted = field.startsWith("provenance.");
    const key = dotted ? field.slice("provenance.".length) : field;
    const old = dotted ? provenance[key] : (result as unknown as Record<string, unknown>)[key];
    const same =
      field === "provenance.produced_at"
        ? typeof old === "string" && Date.parse(old) === Date.parse(String(value))
        : Array.isArray(value)
          ? JSON.stringify(old) === JSON.stringify(value)
          : old === value;
    // The stored value already says this. Nothing is written and the
    // timeline states no change, like the real route.
    if (same) continue;
    if (dotted) provenance[key] = value;
    else (result as unknown as Record<string, unknown>)[key] = value;
    if (field === "provenance.input_file_ids") inputsChanged = true;
    entries.push({
      id: `j-${crypto.randomUUID()}`,
      entity_type: "result",
      entity_id: resultId,
      field: `result.${field}`,
      kind: "change",
      old: old === null || old === undefined ? "(empty)" : String(old),
      new: String(value),
      source: "manual",
      actor,
      note,
      at,
      // The run timeline unions the entries that name it as the context, so
      // a result edit shows on the run timeline as well.
      context_run_id: result.run_id,
    });
  }

  if (inputsChanged) {
    // Derived, never stated: the status follows the inputs the way the real
    // route re-derives it, and it writes no journal entry of its own. An
    // input names a registered file of THIS run by id or by filename.
    const known = new Set<string>();
    for (const file of state.files) {
      if (file.run_id !== result.run_id || file.status !== "registered") continue;
      known.add(file.file_id);
      known.add(file.filename);
    }
    const inputs = result.provenance.input_file_ids;
    const verified = inputs.length > 0 && inputs.every((id) => known.has(id));
    result.provenance_status = verified ? "verified" : "flagged";
  }

  if (entries.length > 0) {
    state.journal.push(...entries);
    // The edited mark reads back from the journal, like `_edit_marks`: every
    // manual change field, sorted, and the newest entry names the person.
    const manual = state.journal.filter(
      (e) => e.entity_type === "result" && e.entity_id === resultId && e.kind === "change" && e.source === "manual",
    );
    const newest = manual.reduce((top, e) => (e.at >= top.at ? e : top));
    result.edited = {
      at: newest.at,
      actor: newest.actor,
      fields: [...new Set(manual.map((e) => e.field ?? ""))].sort(),
    };
  }
  return result;
}

/**
 * Prepare a mock result download: run the checks the BE runs, then append the
 * audit journal entry **before** any byte returns (audit-before-bytes).
 *
 * Throws:
 *  - `result_not_found` (404) — unknown id
 *  - `result_has_no_bytes` (409) — the result names no storage reference, so
 *    the registry holds nothing to download. It is never a 404: the result
 *    itself is there.
 *
 * The mock has no persistence layer to fail, so there is no 503 path here.
 */
export function prepareResultDownload(
  state: MockState,
  resultId: string,
): { result: ProcessedResult; audit: JournalRecord } {
  const result = getResult(state, resultId);
  if (!result.storage_ref || !result.storage_ref.trim()) {
    throw new MockDbError(
      409,
      "result_has_no_bytes",
      `Result ${resultId} carries no stored bytes: it names no storage reference, so this registry holds nothing to download.`,
    );
  }
  const audit: JournalRecord = {
    id: `j-${crypto.randomUUID()}`,
    entity_type: "result",
    entity_id: resultId,
    field: "result.downloaded",
    kind: "event",
    old: null,
    new: null,
    source: "manual",
    actor: "static token holder",
    note: `Downloaded ${result.name} (mock — deterministic payload)`,
    at: nowIso(),
  };
  state.journal.push(audit);
  return { result, audit };
}

/**
 * `POST /results/upload` (mock half) — mint one result row for uploaded
 * bytes. The route hands over the parsed `metadata` part and what it
 * measured about the bytes; this stores the row, decides the provenance
 * verdict the way `POST /results` does (inputs must name registered files
 * of the run, and no inputs at all means no traceability → flagged), mints
 * the storage reference the server owns (a metadata part that carries one
 * answers 422 `storage_ref_not_allowed`), and writes the audit entry the
 * route surfaces as `X-Journal-Id`. Deliberately skipped: the byte-replay
 * check and the version race guard — one process, no real bytes.
 */
export function uploadResult(
  state: MockState,
  metadataRaw: unknown,
  uploadedFilename: string,
  sizeBytes: number,
): { result: ProcessedResult; audit: JournalRecord } {
  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = typeof metadataRaw === "string" ? JSON.parse(metadataRaw) : null;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    metadata = parsed as Record<string, unknown>;
  } catch {
    throw validation("validation_error", "metadata must be a JSON object", [
      { loc: ["body", "metadata"], msg: "invalid JSON object", type: "value_error" },
    ]);
  }
  if (metadata.storage_ref !== undefined) {
    throw validation("storage_ref_not_allowed", "the server mints storage_ref; do not send one");
  }
  const runId = typeof metadata.run_id === "string" ? metadata.run_id : "";
  const name = typeof metadata.name === "string" ? metadata.name : "";
  const resultKey = typeof metadata.result_key === "string" ? metadata.result_key : "";
  const provenance = metadata.provenance;
  if (runId === "" || name === "" || resultKey === "" || provenance === null || typeof provenance !== "object") {
    throw validation("validation_error", "metadata needs run_id, name, result_key and provenance", [
      { loc: ["body", "metadata"], msg: "field required", type: "value_error.missing" },
    ]);
  }
  if (!state.runs.some((r) => r.run_id === runId)) {
    throw validation("unknown_run", `No run ${runId} is registered here`);
  }
  const prov = provenance as Record<string, unknown>;
  const inputIds = Array.isArray(prov.input_file_ids)
    ? prov.input_file_ids.filter((id): id is string => typeof id === "string")
    : [];
  // Verified provenance needs at least one input, and every input must name
  // a registered file of THIS run. The flag never drops the result.
  const runFileIds = new Set(state.files.filter((f) => f.run_id === runId).map((f) => f.file_id));
  const verified = inputIds.length > 0 && inputIds.every((id) => runFileIds.has(id));

  const chain = state.results.filter((r) => r.run_id === runId && r.result_key === resultKey);
  const latest = chain.reduce<ProcessedResult | null>(
    (top, r) => (top === null || r.version > top.version ? r : top),
    null,
  );
  const resultId = newId("res");
  const at = nowIso();
  const result: ProcessedResult = {
    result_id: resultId,
    run_id: runId,
    name,
    result_key: resultKey,
    version: latest === null ? 1 : latest.version + 1,
    supersedes: latest === null ? null : latest.result_id,
    description: typeof metadata.description === "string" ? metadata.description : null,
    storage_ref: `blob://test-manager/results/${resultId}/${encodeURIComponent(uploadedFilename)}`,
    provenance: {
      tool: typeof prov.tool === "string" ? prov.tool : "unknown",
      tool_version: typeof prov.tool_version === "string" ? prov.tool_version : "unknown",
      parameters: typeof prov.parameters === "string" ? prov.parameters : "",
      input_file_ids: inputIds,
      produced_by: typeof prov.produced_by === "string" ? prov.produced_by : "unknown",
      produced_at: typeof prov.produced_at === "string" ? prov.produced_at : at,
    },
    provenance_status: verified ? "verified" : "flagged",
    created_at: at,
  };
  state.results.push(result);
  // Audit-after-bytes, like the real upload route: the entry states bytes
  // the (mock) store already holds, so it never fabricates a trace.
  const audit: JournalRecord = {
    id: `j-${crypto.randomUUID()}`,
    entity_type: "result",
    entity_id: resultId,
    field: "result.uploaded",
    kind: "event",
    old: null,
    new: null,
    source: "manual",
    actor: "static token holder",
    note: `Uploaded ${name} v${result.version} (${formatSize(sizeBytes)}, mock store)`,
    at,
  };
  state.journal.push(audit);
  return { result, audit };
}

/**
 * The work order that links this definition, or null.
 *
 * A definition may carry several links. Only a mirrored work order counts —
 * a link to a work order the registry does not hold reads as no link at all.
 */
function definitionWorkOrder(state: MockState, tdId: string): WorkOrderRecord | null {
  for (const link of state.woDefinitions.filter((l) => l.td_id === tdId)) {
    const wo = state.workOrders.find((w) => w.wo_id === link.wo_id && w.mirrored);
    if (wo) return wo;
  }
  return null;
}

function toTestDefinitionListItem(
  state: MockState,
  definition: DefinitionRecord,
): TestDefinitionListItem {
  const wo = definitionWorkOrder(state, definition.td_id);
  const link =
    wo === null
      ? undefined
      : state.woDefinitions.find((l) => l.td_id === definition.td_id && l.wo_id === wo.wo_id);
  const planned = link?.planned_runs ?? 0;
  const actual = state.runs.filter((r) => r.definition_id === definition.td_id).length;
  return {
    td_id: definition.td_id,
    title: definition.title,
    work_order_id: wo?.wo_id ?? null,
    planned_runs: planned,
    actual_runs: actual,
    status: actual >= planned ? "on_plan" : "awaiting_data",
    orphaned: wo === null,
    synced_at: wo?.synced_at ?? SEED_WO_SYNCED_AT,
    // No mock result carries a verdict block, so a definition a run carries
    // is unjudged and one no run carries has not been run.
    verdict_state: actual > 0 ? "no_verdict" : "not_run",
    latest_verdict: null,
  };
}

/** Definitions the registry mirrors, orphans first-class (contract TR-001). */
export function listTestDefinitions(
  state: MockState,
  filters: TestDefinitionListFilters,
  pagination: Pagination,
): TestDefinitionListResponse {
  // The API fixes the sort on the id, lowest first, and takes no sort param.
  let items = state.definitions
    .filter((d) => d.mirrored)
    .map((d) => toTestDefinitionListItem(state, d))
    .sort((a, b) => a.td_id.localeCompare(b.td_id));
  if (filters.orphaned !== undefined) {
    items = items.filter((d) => d.orphaned === filters.orphaned);
  }
  return paginate(items, pagination);
}

/**
 * One definition, its work order and the runs that carry it.
 *
 * The row half comes from the same builder the list uses, so the two reads
 * can never disagree about a definition.
 */
export function getTestDefinition(state: MockState, tdId: string): TestDefinitionDetail {
  const definition = state.definitions.find((d) => d.td_id === tdId && d.mirrored);
  if (!definition) throw notFound("td_not_found", `Test definition ${tdId} not found`);
  const wo = definitionWorkOrder(state, tdId);
  const runs = state.runs
    .filter((r) => r.definition_id === tdId)
    .sort((a, b) => b.first_data_at.localeCompare(a.first_data_at));
  return {
    ...toTestDefinitionListItem(state, definition),
    work_order:
      wo === null
        ? null
        : { wo_id: wo.wo_id, title: wo.title, project: wo.project, status: wo.status },
    runs: runs.map((r) => ({
      run_id: r.run_id,
      definition_id: r.definition_id,
      rig_id: r.rig_id,
      test_cell: r.test_cell,
      first_data_at: r.first_data_at,
      file_count: r.file_count,
      signal_count: r.signal_count,
      status: runStatus(r),
    })),
    requirements_files: sortRequirementsFiles(definition.requirements_files),
    custom_properties: { ...(definition.custom_properties ?? {}) },
  };
}


/* The requirements documents of one definition. The API serves them in one
   order — manual first, then by name — so the screen never sorts them. */

/** The mock has no identity to read, so every manual write carries this name. */
const MOCK_MANUAL_ACTOR = "a.bergstrom";

function sortRequirementsFiles(files: RequirementsFile[]): RequirementsFile[] {
  return [...files].sort((a, b) => {
    if (a.source !== b.source) return a.source === "manual" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function definitionOrThrow(state: MockState, tdId: string): DefinitionRecord {
  const definition = state.definitions.find((d) => d.td_id === tdId && d.mirrored);
  if (!definition) throw notFound("td_not_found", `Test definition ${tdId} not found`);
  return definition;
}

/** POST /test-definitions/{td_id}/requirements-files. Always source `manual`. */
export function addRequirementsFile(
  state: MockState,
  tdId: string,
  body: Record<string, unknown>,
): RequirementsFile {
  const definition = definitionOrThrow(state, tdId);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (name.length === 0) {
    throw validation("validation_error", "A requirements document needs a name", [
      { loc: ["body", "name"], msg: "field required", type: "value_error" },
    ]);
  }
  if (content.trim().length === 0) {
    throw validation("validation_error", "A requirements document needs some text", [
      { loc: ["body", "content"], msg: "field required", type: "value_error" },
    ]);
  }
  if (definition.requirements_files.some((f) => f.name === name)) {
    throw new MockDbError(
      409,
      "requirements_file_exists",
      `Test definition ${tdId} already carries a document named ${name}`,
    );
  }
  const file: RequirementsFile = {
    name,
    content,
    source: "manual",
    updated_at: nowIso(),
    updated_by: MOCK_MANUAL_ACTOR,
    // The API reads the flag off the body, and it falls back to the name.
    render_markdown:
      typeof body.render_markdown === "boolean"
        ? body.render_markdown
        : name.toLowerCase().endsWith(".md"),
    storage_ref: null,
    content_type: null,
    size_bytes: null,
  };
  definition.requirements_files.push(file);
  return file;
}

/**
 * PATCH /test-definitions/{td_id}/requirements-files/{name}.
 *
 * It changes the text of one manual TEXT document, and the markdown flag with
 * it. It never changes the name: the path names the document. Planning owns a
 * `planning` document, and bytes are replaced by uploading the file again, so
 * this refuses both.
 */
export function editRequirementsFile(
  state: MockState,
  tdId: string,
  name: string,
  body: Record<string, unknown>,
): RequirementsFile {
  const definition = definitionOrThrow(state, tdId);
  const file = definition.requirements_files.find((f) => f.name === name);
  if (!file) {
    throw notFound(
      "requirements_file_not_found",
      `Test definition ${tdId} carries no document named ${name}`,
    );
  }
  if (file.source !== "manual") {
    throw new MockDbError(
      409,
      "requirements_file_not_manual",
      `The planning system owns ${name}. Change it in the planning system.`,
    );
  }
  if (typeof file.storage_ref === "string" && file.storage_ref.length > 0) {
    throw new MockDbError(
      409,
      "requirements_file_has_no_text",
      `The requirements file ${name} holds bytes, not text. Upload the file again.`,
    );
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (content.trim().length === 0) {
    throw validation("validation_error", "A requirements document needs some text", [
      { loc: ["body", "content"], msg: "field required", type: "value_error" },
    ]);
  }
  file.content = content;
  if (typeof body.render_markdown === "boolean") file.render_markdown = body.render_markdown;
  file.updated_at = nowIso();
  file.updated_by = MOCK_MANUAL_ACTOR;
  return file;
}

/**
 * DELETE /test-definitions/{td_id}/requirements-files/{name}.
 *
 * Planning owns a `planning` document, so this refuses to remove one. Only a
 * manual document goes.
 */
export function removeRequirementsFile(state: MockState, tdId: string, name: string): void {
  const definition = definitionOrThrow(state, tdId);
  const file = definition.requirements_files.find((f) => f.name === name);
  if (!file) {
    throw notFound(
      "requirements_file_not_found",
      `Test definition ${tdId} carries no document named ${name}`,
    );
  }
  if (file.source !== "manual") {
    throw new MockDbError(
      409,
      "requirements_file_not_manual",
      `The planning system owns ${name}. Remove it in the planning system.`,
    );
  }
  definition.requirements_files = definition.requirements_files.filter((f) => f.name !== name);
}

/**
 * PATCH /test-definitions/{td_id}/custom-properties.
 *
 * The map replaces the stored map whole, so `{}` clears every property. An
 * unchanged map writes nothing and journals nothing. The pairs never touch a
 * planning field, so no sync pass here can erase one.
 */
export function setDefinitionCustomProperties(
  state: MockState,
  tdId: string,
  body: Record<string, unknown>,
): { custom_properties: Record<string, string> } {
  const definition = definitionOrThrow(state, tdId);
  const properties = body.custom_properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    throw validation("validation_error", "custom_properties must be an object", [
      { loc: ["body", "custom_properties"], msg: "field required", type: "value_error" },
    ]);
  }
  const map = properties as Record<string, string>;
  checkCustomProperties(map);

  const previous = definition.custom_properties ?? {};
  if (sameProperties(previous, map)) return { custom_properties: { ...previous } };

  const at = nowIso();
  definition.custom_properties = { ...map };
  state.journal.push({
    id: `j-${crypto.randomUUID()}`,
    entity_type: "test_definition",
    entity_id: tdId,
    field: "test_definition.custom_properties",
    kind: "change",
    old: showProperties(previous),
    new: showProperties(map),
    source: "manual",
    actor: MOCK_MANUAL_ACTOR,
    note: typeof body.note === "string" ? body.note : null,
    at,
  });
  return { custom_properties: { ...definition.custom_properties } };
}

export function getHomeSummary(state: MockState): HomeSummary {
  const recent = [...state.runs]
    .sort((a, b) => b.first_data_at.localeCompare(a.first_data_at))
    .slice(0, 5);
  // The same sets the four counts below read, so the rows and the counts can
  // never disagree inside one answer. The real API caps at three per
  // category; the mock mirrors it.
  const newestFirst = (a: { first_data_at: string }, b: { first_data_at: string }) =>
    b.first_data_at.localeCompare(a.first_data_at);
  const awaiting = state.runs.filter((r) => runStatus(r) === "awaiting_work_order");
  const quarantined = state.files.filter((f) => f.status === "quarantined");
  const invalid = state.runs.filter((r) => r.invalid.flagged);
  const orphaned = state.definitions.filter(
    (d) => d.mirrored && definitionWorkOrder(state, d.td_id) === null,
  );
  return {
    counts: { ...VANITY_COUNTS },
    needs_attention: {
      awaiting_work_order: awaiting.length,
      quarantined_files: quarantined.length,
      invalid_runs: invalid.length,
      orphaned_definitions: orphaned.length,
    },
    attention_rows: {
      awaiting_work_order: [...awaiting]
        .sort(newestFirst)
        .slice(0, 3)
        .map((r) => ({ run_id: r.run_id, rig_id: r.rig_id, reason: null })),
      quarantined_files: [...quarantined]
        .sort((a, b) => b.registered_at.localeCompare(a.registered_at))
        .slice(0, 3)
        .map((f) => ({
          file_id: f.file_id,
          filename: f.filename,
          quarantine_reason: f.quarantine_reason,
        })),
      invalid_runs: [...invalid]
        .sort(newestFirst)
        .slice(0, 3)
        .map((r) => ({ run_id: r.run_id, rig_id: r.rig_id, reason: r.invalid.reason })),
      orphaned_definitions: [...orphaned]
        .sort((a, b) => a.td_id.localeCompare(b.td_id))
        .slice(0, 3)
        .map((d) => ({ td_id: d.td_id, title: d.title })),
    },
    planning_sync: { online: state.planningOnline, last_sync_at: state.lastSyncAt },
    recent_runs: recent.map((r) => ({
      run_id: r.run_id,
      description: r.description,
      definition_id: r.definition_id,
      work_order_id: r.work_order_id,
      rig_id: r.rig_id,
      first_data_at: r.first_data_at,
      status: runStatus(r),
    })),
    source_breakdown: sourceBreakdown(state),
  };
}

/* The order the API serves, which is the `Source` enum order. The card reads
   the list as it arrives, so the two sides never disagree on the order. */
const SOURCE_ORDER: readonly SourceTag[] = [
  "embedded",
  "manual",
  "api:planning",
  "api:config",
  "api:catalogue",
  "api:post-processing",
];

/**
 * One row per source, counting the tagged metadata fields — TR-011.
 *
 * The mock counts the same four collections the API counts, in the same enum
 * order, and keeps a source that wrote nothing at zero.
 */
function sourceBreakdown(state: MockState): SourceCount[] {
  const counted = new Map<string, number>();
  const tagged = [
    ...state.runs.map((row) => row.field_sources),
    ...state.files.map((row) => row.field_sources),
    ...state.signals.map((row) => row.field_sources),
    ...state.workOrders.map((row) => row.field_sources),
  ];
  for (const map of tagged) {
    for (const entry of Object.values(map ?? {})) {
      counted.set(entry.source, (counted.get(entry.source) ?? 0) + 1);
    }
  }
  return SOURCE_ORDER.map((source) => ({
    source,
    field_count: counted.get(source) ?? 0,
  }));
}

export function getSyncStatus(state: MockState): PlanningSyncStatus {
  return {
    online: state.planningOnline,
    last_sync_at: state.lastSyncAt,
    last_sync_result: state.lastSyncResult,
    work_orders_mirrored: WORK_ORDERS_MIRRORED,
  };
}

/**
 * One mock sync pass — the shared body of toggle-ON and the trigger route.
 * Mirrors every WO and definition, backfills the hero run once, and records
 * a truthful summary: a pass that found nothing left to backfill reports 0,
 * it never re-claims the first pass's work.
 */
function runSyncPass(state: MockState): void {
  const at = nowIso();
  for (const wo of state.workOrders) {
    wo.mirrored = true;
    wo.synced_at = at;
  }
  for (const def of state.definitions) def.mirrored = true;
  let backfilled = 0;
  const hero = requireRun(state, HERO_RUN_ID);
  if (!hero.work_order_id) {
    backfilled = 1;
    hero.work_order_id = SYNC_WO_ID;
    hero.definition_id = SYNC_TD_ID;
    hero.project = SYNC_PROJECT;
    const backfill = { source: "api:planning" as const, actor: "planning-sync", at };
    hero.field_sources.work_order_id = backfill;
    hero.field_sources.definition_id = backfill;
    hero.field_sources.project = backfill;
    hero.updated_at = at;
    state.journal.push({
      id: `j-${crypto.randomUUID()}`,
      entity_type: "run",
      entity_id: HERO_RUN_ID,
      field: "run.work_order",
      kind: "change",
      old: "(empty)",
      new: SYNC_WO_ID,
      source: "api:planning",
      actor: "planning-sync",
      note: `Backfilled from planning system — definition ${SYNC_TD_ID} and project ${SYNC_PROJECT} linked.`,
      at,
      sync_generated: true,
    });
  }
  state.lastSyncAt = at;
  state.lastSyncResult = {
    work_orders: state.workOrders.filter((w) => w.mirrored).length,
    definitions: state.definitions.filter((d) => d.mirrored).length,
    runs_backfilled: backfilled,
  };
}

export function toggleSync(state: MockState, online: unknown): PlanningSyncToggleResponse {
  if (typeof online !== "boolean") {
    throw validation("validation_error", "body must be { online: boolean }", [
      { loc: ["body", "online"], msg: "field required", type: "value_error.missing" },
    ]);
  }
  if (online === state.planningOnline) return getSyncStatus(state);

  if (online) {
    state.planningOnline = true;
    runSyncPass(state);
    return getSyncStatus(state);
  }

  // Toggle OFF stops the sync and changes no data. A registry never
  // un-remembers: every mirrored row, every backfilled field and every journal
  // entry stays. The API answers the same way.
  state.planningOnline = false;
  return getSyncStatus(state);
}

/**
 * `POST /planning-sync/trigger` (★) — run one pass WITHOUT touching the
 * switch, like the real route. On an already-synced world the pass finds
 * nothing to backfill and the summary says so.
 */
export function triggerSyncPass(state: MockState): PlanningSyncStatus {
  runSyncPass(state);
  return getSyncStatus(state);
}

/* ─────────────────────────── Explore (plan §2/§4) ───────────────────────────
 *
 * Two mock halves. `getExploreContext` backs the mock GET /explore/context
 * route. `runLakeQuery` backs the FE's own POST /api/lake/query handler when
 * it runs in mock mode (TM_USE_MOCK_API / TM_TEST_HOOKS) — Explore SQL goes
 * to the lake verbatim now, so there is no guard to emulate: the only refusal
 * left is the LAKE's own (a read-only connection refusing anything that is
 * not a SELECT). Results derive deterministically from the run's seeded
 * signals.
 */

/** Pinned lake projection (api/ingest/lake.py COLUMNS). */
export const EXPLORE_COLUMNS = ["run_id", "signal", "timestamp", "value", "filename"] as const;

/** Mirrors MAX_ROWS in app/api/lake/query/route.ts — the route's browser-protecting cap. */
export const EXPLORE_MAX_LIMIT = 10000;

/** Small deterministic string hash (FNV-1a) for per-run/per-signal seeding. */
function exploreHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function exploreRunDurationSec(run: RunRecord): number {
  const ms = Date.parse(run.ended_at) - Date.parse(run.started_at);
  return Math.max(1, Math.round(ms / 1000));
}

export function getExploreContext(state: MockState, runId: string): ExploreContext {
  const run = requireRun(state, runId);
  const signals = mergedRunSignals(state, runId);
  // Deterministic "lakeside" sample count: Σ per-signal rate × run duration.
  const duration = exploreRunDurationSec(run);
  const sampleCount = signals.reduce((sum, s) => sum + Math.round(s.rate_hz * duration), 0);
  return {
    table: "test_signal_samples",
    columns: [...EXPLORE_COLUMNS],
    file_count: run.file_count,
    signal_count: run.signal_count,
    sample_count: sampleCount > 0 ? sampleCount : null,
    // Phase 4 — the mock chat route (explore/chat) streams canned frames, so
    // Ask AI is demoable in mock mode. The real backend reports this itself.
    ai_available: true,
  };
}

/** Deterministic waveform for one signal, scaled to its seeded stats. */
function exploreValue(signal: FileSignal, seed: number, position: number): number {
  const stats = signal.stats;
  const mean = stats?.mean ?? 20;
  const amp = stats ? Math.max((stats.max - stats.min) / 2, 0.5) : 5;
  const phase = (seed % 997) / 997;
  const cycles = 3 + (seed % 5);
  const wave =
    0.62 * Math.sin(2 * Math.PI * (position * cycles + phase)) +
    0.28 * Math.sin(2 * Math.PI * (position * cycles * 3.7 + phase * 2.3));
  const value = mean + amp * wave;
  if (!stats) return value;
  return Math.min(stats.max, Math.max(stats.min, value));
}

function exploreIso(epochMs: number): string {
  return new Date(Math.round(epochMs)).toISOString().replace(/\.000Z$/, "Z");
}

function parseExploreWindow(sql: string, run: RunRecord): { fromMs: number; toMs: number } {
  let fromMs = Date.parse(run.started_at);
  let toMs = Date.parse(run.ended_at);
  // Quoted ISO strings — the shape hand-written SQL tends to use.
  const between = /timestamp\s+between\s+'([^']+)'\s+and\s+'([^']+)'/i.exec(sql);
  // Unquoted epoch-ms numbers against either time-column spelling — the
  // shape buildVizSql emits for a drag-zoom requery (`ts_ms BETWEEN
  // 1755162067000 AND 1755162131000`). Without this branch the mock ignored
  // the window and zoom was a silent no-op in mock/e2e mode.
  const epochBetween = /(?:timestamp|ts_ms)\s+between\s+(\d+)\s+and\s+(\d+)/i.exec(sql);
  if (between) {
    const from = Date.parse(between[1]);
    const to = Date.parse(between[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      fromMs = from;
      toMs = to;
    }
  } else if (epochBetween) {
    const from = Number(epochBetween[1]);
    const to = Number(epochBetween[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      fromMs = from;
      toMs = to;
    }
  }
  return { fromMs, toMs };
}

/** The trailing `LIMIT n` the statement carries (the last one wins), or null. */
function parseSqlLimit(sql: string): number | null {
  const matches = [...sql.matchAll(/\blimit\s+(\d+)/gi)];
  const last = matches[matches.length - 1];
  return last !== undefined ? Number(last[1]) : null;
}

/** The run scope named in the SQL text (`run_id = '…'`), or null. */
function parseSqlRunId(sql: string): string | null {
  const match = /\brun_id\s*=\s*'((?:[^']|'')*)'/i.exec(sql);
  return match !== null ? match[1].replaceAll("''", "'") : null;
}

/**
 * The mock lake. Backs POST /api/lake/query in mock mode: the SQL arrives
 * VERBATIM (no guard exists on this path any more), so this emulates what
 * the real lake would answer — a read-only refusal for anything that is not
 * a SELECT (the route surfaces it as 400 lake_query_error, like a real
 * `# ERROR:` trailer), zero rows for a run the lake does not hold, and
 * otherwise a deterministic result derived from the scoped run's seeded
 * signals. The SQL's own LIMIT is honored the way the lake would honor it;
 * `truncated` only flags the route's EXPLORE_MAX_LIMIT cap.
 */
export function runLakeQuery(state: MockState, sql: string): ExploreQueryResult {
  const statement = (/^\s*([A-Za-z]+)/.exec(sql)?.[1] ?? "").toUpperCase();
  if (statement !== "SELECT") {
    throw new MockDbError(
      400,
      "lake_query_error",
      `Cannot execute a statement of type "${statement || "UNKNOWN"}": the lake connection is read-only`,
    );
  }

  // The run scope lives in the SQL text on this path. A statement that names
  // no run reads across the whole lake, which this mock approximates with
  // the seeded hero run's data. An unknown run id is not an error to the
  // lake — the WHERE clause simply matches nothing.
  const scopedRunId = parseSqlRunId(sql);
  const run =
    scopedRunId === null
      ? (state.runs.find((r) => r.run_id === HERO_RUN_ID) ?? state.runs[0])
      : state.runs.find((r) => r.run_id === scopedRunId);
  if (run === undefined) {
    return { columns: [], rows: [], row_count: 0, truncated: false, elapsed_ms: 12 };
  }
  const runId = run.run_id;

  const sqlLimit = parseSqlLimit(sql);
  const limit = Math.min(sqlLimit ?? EXPLORE_MAX_LIMIT, EXPLORE_MAX_LIMIT);

  const allSignals = mergedRunSignals(state, runId);
  const quoted = [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const matched = allSignals.filter((s) => quoted.includes(s.name));
  const { fromMs, toMs } = parseExploreWindow(sql, run);
  const runSeed = exploreHash(runId);

  const grouped = /\bgroup\s+by\b/i.test(sql);
  const bucketed = /\btime_bucket\s*\(/i.test(sql);

  let columns: string[];
  let rows: string[][];
  let totalAvailable: number;

  if (grouped && !bucketed) {
    // Aggregate shape — one row per signal (the "Per-signal stats" family).
    const selected = matched.length > 0 ? matched : allSignals;
    columns = ["signal", "min", "max", "avg", "samples"];
    const duration = Math.max(1, Math.round((toMs - fromMs) / 1000));
    rows = selected.map((signal) => {
      const stats = signal.stats;
      return [
        signal.name,
        (stats?.min ?? 0).toFixed(2),
        (stats?.max ?? 0).toFixed(2),
        (stats?.mean ?? 0).toFixed(2),
        String(Math.round(signal.rate_hz * duration)),
      ];
    });
    totalAvailable = rows.length;
  } else {
    // Time-series shape — bucketed (time_bucket) or raw samples.
    const fallback = allSignals.slice(0, 2);
    const selected = matched.length > 0 ? matched : fallback;
    const perSignal = selected.length > 0 ? Math.max(1, Math.floor(limit / selected.length)) : 0;
    const natural = bucketed ? 300 : 1200; // generator resolution per signal
    const points = Math.min(natural, perSignal);
    columns = bucketed ? ["signal", "ts", "value"] : ["signal", "timestamp", "value"];
    rows = [];
    // The waveform is a function of absolute run time (position within the
    // whole run), not of the queried window — so a narrowed BETWEEN window
    // (Visualise drag-zoom) returns a magnified slice of the same waveform
    // instead of regenerating the full shape inside the narrow window.
    const runFromMs = Date.parse(run.started_at);
    const runSpanMs = Math.max(1, Date.parse(run.ended_at) - runFromMs);
    for (let i = 0; i < points; i++) {
      const position = points === 1 ? 0 : i / (points - 1);
      const tsMs = fromMs + (toMs - fromMs) * position;
      const ts = exploreIso(tsMs);
      const wavePosition = (tsMs - runFromMs) / runSpanMs;
      for (const signal of selected) {
        rows.push([
          signal.name,
          ts,
          exploreValue(signal, runSeed ^ exploreHash(signal.name), wavePosition).toFixed(2),
        ]);
      }
    }
    totalAvailable = natural * selected.length;
  }

  // What the lake would serve after honoring the SQL's own LIMIT — the route
  // cap is the only thing that reads as truncation.
  const lakeRows = Math.min(totalAvailable, sqlLimit ?? Number.POSITIVE_INFINITY);
  const truncated = lakeRows > EXPLORE_MAX_LIMIT;
  if (rows.length > limit) rows = rows.slice(0, limit);

  return {
    columns: columns.map((name) => ({ name })),
    rows,
    row_count: rows.length,
    truncated,
    // Deterministic but plausible lakeside timing.
    elapsed_ms: 24 + ((runSeed + rows.length) % 380),
  };
}

export function search(state: MockState, query: string, limitPerGroup: number): SearchResults {
  const rx = searchRegex(query);
  const groups: SearchGroup[] = [];

  const runItems: SearchItem[] = state.runs
    .filter((r) => rx.test(r.run_id) || rx.test(r.description) || rx.test(r.rig_id))
    .sort((a, b) => b.first_data_at.localeCompare(a.first_data_at))
    .slice(0, limitPerGroup)
    .map((r) => ({
      id: r.run_id,
      sub: `${r.description} · ${r.rig_id}`,
      status: runStatus(r),
      nav: { run_id: r.run_id },
    }));
  if (runItems.length > 0) groups.push({ type: "test_runs", items: runItems });

  const woItems: SearchItem[] = mirroredWorkOrders(state)
    .filter((w) => rx.test(w.wo_id) || rx.test(w.title) || rx.test(w.project))
    .slice(0, limitPerGroup)
    .map((w) => ({
      id: w.wo_id,
      sub: `${w.title} · ${w.project}`,
      status: w.status,
      nav: { wo_id: w.wo_id },
    }));
  if (woItems.length > 0) groups.push({ type: "work_orders", items: woItems });

  const fileItems: SearchItem[] = state.files
    .filter((f) => rx.test(f.filename) || rx.test(f.checksum_sha256) || rx.test(f.run_id ?? ""))
    .slice(0, limitPerGroup)
    .map((f) => ({
      id: f.filename,
      sub: `${f.run_id ?? "unlinked"} · ${formatSize(f.size_bytes)} · ${f.source_system}`,
      status: f.status,
      nav: { file_id: f.file_id },
    }));
  if (fileItems.length > 0) groups.push({ type: "files", items: fileItems });

  const signalItems: SearchItem[] = state.signals
    .filter((s) => rx.test(s.name) || rx.test(s.description))
    .slice(0, limitPerGroup)
    .map((s) => ({
      id: s.name,
      sub: `${s.unit ?? "(no unit)"} · ${s.typical_rate_hz} Hz · ${s.run_count} runs`,
      status: null,
      nav: { name: s.name },
    }));
  if (signalItems.length > 0) groups.push({ type: "signals", items: signalItems });

  /* Six groups since 19 Aug 2026 (contract #19). A definition and a result own
     no detail route, so each hit navigates to a runs list. */
  const woOf = (tdId: string): string | undefined =>
    state.woDefinitions.find((l) => l.td_id === tdId)?.wo_id;

  /* An unmirrored definition is not in the backend collection yet, so the mock
     hides it too. `mirroredWorkOrders` hides its work order the same way. */
  const defItems: SearchItem[] = state.definitions
    .filter((d) => d.mirrored)
    .filter((d) => rx.test(d.td_id) || rx.test(d.title) || rx.test(woOf(d.td_id) ?? ""))
    .slice(0, limitPerGroup)
    .map((d) => ({
      id: d.td_id,
      sub: [d.title, woOf(d.td_id)].filter(Boolean).join(" · "),
      status: null,
      nav: { definition: d.td_id },
    }));
  if (defItems.length > 0) groups.push({ type: "test_definitions", items: defItems });

  const resultItems: SearchItem[] = state.results
    .filter(
      (r) =>
        rx.test(r.result_id) || rx.test(r.name) || rx.test(r.result_key) || rx.test(r.run_id)
    )
    .slice(0, limitPerGroup)
    .map((r) => ({
      id: r.name,
      sub: `${r.run_id} · v${r.version}`,
      status: r.provenance_status,
      nav: { run_id: r.run_id },
    }));
  if (resultItems.length > 0) {
    groups.push({ type: "processed_results", items: resultItems });
  }

  return { query, groups };
}
