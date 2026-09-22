/**
 * Mock write routes (M1 — e2e/demo parity with the 20 Aug 2026 API).
 *
 * These pin the db half of the new mock handlers: file lifecycle
 * (archive/restore/soft delete), the version chain, the manual run link on
 * PATCH /files, the invalid-flag counterpart, run notes, the generic journal
 * event, the result upload and the planning-sync trigger. The rules asserted
 * here are copied from the real routers (`api/api/routers/files.py`,
 * `test_runs.py`, `journal.py`, `results.py`, `planning_sync.py`) — when one
 * side changes, this suite is the tripwire for the mock.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  addJournalEvent,
  addRunNote,
  archiveFile,
  clearInvalidFlag,
  flagInvalid,
  getDb,
  getFile,
  listFiles,
  listFileVersions,
  patchFile,
  registerFileVersion,
  requestAccess,
  resetDb,
  restoreFile,
  softDeleteFile,
  toggleSync,
  triggerSyncPass,
  uploadResult,
} from "@/lib/mock/db";
import { MockDbError } from "@/lib/mock/errors";
import { FILE_IDS, HERO_RUN_ID } from "@/lib/mock/seed";
import type { MockState } from "@/lib/mock/seed";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

const ACTOR = "t.author";
const page = { page: 1, pageSize: 20 };

function errorOf(fn: () => unknown): MockDbError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MockDbError) return error;
    throw error;
  }
  throw new Error("expected a MockDbError");
}

describe("file lifecycle (archive / restore / soft delete)", () => {
  it("archives, leaves the plain table, shows in the archived view, and restores", () => {
    const archived = archiveFile(state, FILE_IDS.batCyc, ACTOR, "season over");
    expect(archived.lifecycle).toBe("archived");

    expect(listFiles(state, {}, page).items.map((f) => f.file_id)).not.toContain(FILE_IDS.batCyc);
    expect(
      listFiles(state, { lifecycle: ["archived"] }, page).items.map((f) => f.file_id),
    ).toContain(FILE_IDS.batCyc);
    expect(listFiles(state, {}, page).view_counts?.archived).toBe(1);

    const restored = restoreFile(state, FILE_IDS.batCyc, ACTOR, null);
    expect(restored.lifecycle).toBe("active");
  });

  it("soft delete keeps every field and a repeat writes nothing (idempotent)", () => {
    const before = state.journal.length;
    const deleted = softDeleteFile(state, FILE_IDS.batCyc, ACTOR, "wrong rig");
    expect(deleted.lifecycle).toBe("deleted");
    expect(deleted.storage_ref).not.toBeNull();
    softDeleteFile(state, FILE_IDS.batCyc, ACTOR, "again");
    // One file.deleted event only — the repeat journals nothing.
    expect(state.journal.length).toBe(before + 1);
  });

  it("refuses to archive a deleted file (409 file_deleted) and to edit a non-active one", () => {
    softDeleteFile(state, FILE_IDS.batCyc, ACTOR, null);
    expect(errorOf(() => archiveFile(state, FILE_IDS.batCyc, ACTOR, null)).code).toBe("file_deleted");
    expect(
      errorOf(() => patchFile(state, FILE_IDS.batCyc, { run_id: HERO_RUN_ID, actor: ACTOR })).code,
    ).toBe("file_deleted");
  });

  it("restore never touches status — a quarantined file restores to quarantined", () => {
    archiveFile(state, FILE_IDS.emEffQuarantined, ACTOR, null);
    const restored = restoreFile(state, FILE_IDS.emEffQuarantined, ACTOR, null);
    expect(restored.status).toBe("quarantined");
  });

  it("requires the actor (422) like the real FileLifecycleRequest", () => {
    expect(errorOf(() => archiveFile(state, FILE_IDS.batCyc, undefined, null)).status).toBe(422);
  });
});

describe("file version chain", () => {
  const body = {
    filename: "bat_cyc_20260814_0941_v2.mf4",
    source_system: "TAS",
    format: "MDF 4.10",
    size_bytes: 1024,
    checksum_sha256: "feed0000000000000000000000000000000000000000000000000000000000ff",
    actor: ACTOR,
  };

  it("appends version 2 with supersedes, and both ids list the same chain", () => {
    const { file, replayed } = registerFileVersion(state, FILE_IDS.batCyc, body);
    expect(replayed).toBe(false);
    expect(file.version).toBe(2);
    expect(file.run_id).toBe(HERO_RUN_ID); // inherited from the anchor

    const fromRoot = listFileVersions(state, FILE_IDS.batCyc);
    const fromLeaf = listFileVersions(state, file.file_id);
    expect(fromRoot.total).toBe(2);
    expect(fromRoot.items.map((f) => f.file_id)).toEqual(fromLeaf.items.map((f) => f.file_id));
    // Oldest first: the root leads its own chain.
    expect(fromRoot.items[0].file_id).toBe(FILE_IDS.batCyc);
    expect(getFile(state, file.file_id, 10).supersedes).toBe(FILE_IDS.batCyc);
  });

  it("replays a byte-identical upload: same version back, nothing written", () => {
    registerFileVersion(state, FILE_IDS.batCyc, body);
    const files = state.files.length;
    const again = registerFileVersion(state, FILE_IDS.batCyc, body);
    expect(again.replayed).toBe(true);
    expect(again.file.version).toBe(2);
    expect(state.files.length).toBe(files);
  });

  it("refuses a version on an archived anchor (409 file_archived)", () => {
    archiveFile(state, FILE_IDS.batCyc, ACTOR, null);
    expect(errorOf(() => registerFileVersion(state, FILE_IDS.batCyc, body)).code).toBe("file_archived");
  });
});

describe("PATCH /files — the manual run link and stage outcomes", () => {
  it("links an orphaned file and ends a 'no run key' quarantine", () => {
    // Give the seed the shape the promotion rule names: quarantined for the
    // missing link, bytes not in doubt.
    const record = state.files.find((f) => f.file_id === FILE_IDS.invDerateQuarantined);
    if (record === undefined) throw new Error("seed file missing");
    record.quarantine_reason = "no run key";

    const patched = patchFile(state, FILE_IDS.invDerateQuarantined, {
      run_id: HERO_RUN_ID,
      actor: ACTOR,
      note: "run landed",
    });
    expect(patched.run_id).toBe(HERO_RUN_ID);
    expect(patched.status).toBe("registered");
    expect(patched.quarantine_reason).toBeNull();
    const fields = state.journal.slice(-2).map((j) => j.field);
    expect(fields).toEqual(["file.run", "file.unquarantined"]);
  });

  it("never promotes a checksum-mismatch file — the bytes verdict closes the door", () => {
    const record = state.files.find((f) => f.file_id === FILE_IDS.emEffQuarantined);
    if (record === undefined) throw new Error("seed file missing");
    record.quarantine_reason = "no run key"; // mismatch still blocks
    const patched = patchFile(state, FILE_IDS.emEffQuarantined, { run_id: HERO_RUN_ID, actor: ACTOR });
    expect(patched.status).toBe("quarantined");
  });

  it("refuses an unknown run with 422 unknown_run and an empty body with 400", () => {
    expect(
      errorOf(() => patchFile(state, FILE_IDS.batCyc, { run_id: "RUN-NOPE", actor: ACTOR })).code,
    ).toBe("unknown_run");
    expect(errorOf(() => patchFile(state, FILE_IDS.batCyc, { actor: ACTOR })).code).toBe(
      "no_fields_to_update",
    );
  });

  it("records a stage outcome once — a repeated report journals nothing", () => {
    patchFile(state, FILE_IDS.batCyc, { conversion_status: "failed", stage_error: "boom", actor: ACTOR });
    const entries = state.journal.length;
    patchFile(state, FILE_IDS.batCyc, { conversion_status: "failed", actor: ACTOR });
    expect(state.journal.length).toBe(entries);
    expect(getFile(state, FILE_IDS.batCyc, 10).conversion_status).toBe("failed");
    // A stage outcome never ends a quarantine — only the run link does.
    expect(getFile(state, FILE_IDS.batCyc, 10).status).toBe("registered");
  });
});

describe("invalid flag counterpart + run notes", () => {
  it("clears a flag with a reason and journals both halves", () => {
    flagInvalid(state, HERO_RUN_ID, "sensor drift", ACTOR);
    const cleared = clearInvalidFlag(state, HERO_RUN_ID, "false alarm", ACTOR);
    expect(cleared.invalid.flagged).toBe(false);
    expect(cleared.status).not.toBe("invalid");
    const last = state.journal[state.journal.length - 1];
    expect(last.field).toBe("run.invalid_flag");
    expect(last.new).toBe("false");
  });

  it("answers 409 not_flagged for a run nobody flagged, and keeps the reason required", () => {
    expect(errorOf(() => clearInvalidFlag(state, HERO_RUN_ID, "x", ACTOR)).code).toBe("not_flagged");
    flagInvalid(state, HERO_RUN_ID, "drift", ACTOR);
    expect(errorOf(() => clearInvalidFlag(state, HERO_RUN_ID, "  ", ACTOR)).code).toBe("reason_required");
  });

  it("appends a note entry with kind note and no field", () => {
    const entry = addRunNote(state, HERO_RUN_ID, "cell 3 was warm", ACTOR);
    expect(entry.kind).toBe("note");
    expect(entry.field).toBeNull();
    expect(entry.actor).toBe(ACTOR);
  });
});

describe("POST /journal — one event on any entity", () => {
  it("keeps the caller's at and refuses a ghost entity", () => {
    const entry = addJournalEvent(state, {
      entity_type: "file",
      entity_id: FILE_IDS.batCyc,
      field: "file.sync_started",
      kind: "event",
      source: "api:config",
      actor: "ingestion-watcher",
      at: "2026-08-20T07:00:00Z",
    });
    expect(entry.at).toBe("2026-08-20T07:00:00Z");
    expect(entry.kind).toBe("event");

    expect(
      errorOf(() =>
        addJournalEvent(state, {
          entity_type: "file",
          entity_id: "f-ghost",
          field: "file.sync_started",
          kind: "event",
          source: "manual",
          actor: ACTOR,
          at: "2026-08-20T07:00:00Z",
        }),
      ).status,
    ).toBe(404);
  });

  it("pins kind to event", () => {
    expect(
      errorOf(() =>
        addJournalEvent(state, {
          entity_type: "run",
          entity_id: HERO_RUN_ID,
          field: "run.note",
          kind: "note",
          source: "manual",
          actor: ACTOR,
          at: "2026-08-20T07:00:00Z",
        }),
      ).status,
    ).toBe(422);
  });
});

describe("POST /results/upload — mint one result row", () => {
  const metadata = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      run_id: HERO_RUN_ID,
      name: "thermal_summary.parquet",
      result_key: "thermal_summary",
      description: null,
      provenance: {
        tool: "quix-post",
        tool_version: "3.2.0",
        parameters: "window=5s",
        input_file_ids: [FILE_IDS.batCyc],
        produced_by: "t.author",
        produced_at: "2026-08-20T08:00:00Z",
      },
      ...overrides,
    });

  it("stores a verified result when every input names a file of the run", () => {
    const { result, audit } = uploadResult(state, metadata(), "thermal_summary.parquet", 4096);
    expect(result.provenance_status).toBe("verified");
    expect(result.storage_ref).toContain(result.result_id);
    expect(audit.entity_id).toBe(result.result_id);
    expect(state.results.map((r) => r.result_id)).toContain(result.result_id);
  });

  it("flags a result whose inputs do not resolve, and versions the same key", () => {
    const first = uploadResult(state, metadata(), "a.parquet", 10).result;
    const flagged = uploadResult(
      state,
      metadata({ provenance: { input_file_ids: ["f-unknown"] } }),
      "b.parquet",
      10,
    ).result;
    expect(flagged.provenance_status).toBe("flagged");
    expect(flagged.version).toBe(first.version + 1);
    expect(flagged.supersedes).toBe(first.result_id);
  });

  it("refuses an unknown run (422) and a stated storage_ref", () => {
    expect(
      errorOf(() => uploadResult(state, metadata({ run_id: "RUN-NOPE" }), "a.parquet", 10)).code,
    ).toBe("unknown_run");
    expect(
      errorOf(() => uploadResult(state, metadata({ storage_ref: "blob://mine" }), "a.parquet", 10)).code,
    ).toBe("storage_ref_not_allowed");
  });
});

describe("POST /planning-sync/trigger — one pass, switch untouched", () => {
  it("mirrors and backfills without flipping the switch", () => {
    expect(state.planningOnline).toBe(false);
    const status = triggerSyncPass(state);
    expect(status.online).toBe(false);
    expect(status.last_sync_at).not.toBeNull();
    expect(status.last_sync_result?.runs_backfilled).toBe(1);
  });

  it("reports 0 backfills truthfully when a pass finds nothing left", () => {
    toggleSync(state, true);
    const status = triggerSyncPass(state);
    expect(status.last_sync_result?.runs_backfilled).toBe(0);
    expect(status.online).toBe(true);
  });
});

describe("POST /access-requests — the ask is recorded, nothing is granted", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    entity_type: "file",
    entity_id: FILE_IDS.batCyc,
    reason: "I need the raw MF4 for the cell-temperature investigation",
    actor: ACTOR,
    ...overrides,
  });

  it("writes one manual access.requested event carrying the reason", () => {
    const entry = requestAccess(state, body());
    expect(entry.field).toBe("access.requested");
    expect(entry.kind).toBe("event");
    expect(entry.source).toBe("manual");
    expect(entry.entity_type).toBe("file");
    expect(entry.entity_id).toBe(FILE_IDS.batCyc);
    expect(entry.actor).toBe(ACTOR);
    expect(entry.note).toBe("I need the raw MF4 for the cell-temperature investigation");
    // It grants nothing, so it changes no field on either side.
    expect(entry.old).toBeNull();
    expect(entry.new).toBeNull();
  });

  it("refuses an entity nobody holds, and an empty reason", () => {
    expect(errorOf(() => requestAccess(state, body({ entity_id: "f-nope" }))).code).toBe(
      "file_not_found",
    );
    expect(errorOf(() => requestAccess(state, body({ reason: "   " }))).status).toBe(422);
    expect(errorOf(() => requestAccess(state, body({ actor: "" }))).status).toBe(422);
  });
});
