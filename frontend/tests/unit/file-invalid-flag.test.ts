/**
 * The file-level invalid mark in the mock backend (24 Aug 2026 API).
 *
 * The real API grew `POST /files/{id}/invalid-flag` and
 * `DELETE /files/{id}/invalid-flag`, and the mock answered 404 on both. This
 * suite pins the mock against `api/api/routers/files.py`
 * (`flag_file_invalid`, `clear_file_invalid`, `_write_invalid_flag`): the same
 * status codes, the same error codes, the same journal entry, and the mark
 * touching the file and nothing else.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFileInvalidFlag,
  flagFileInvalid,
  getDb,
  getEntityJournal,
  getFile,
  listFiles,
  resetDb,
} from "@/lib/mock/db";
import { FILE_IDS, HERO_RUN_ID, type MockState } from "@/lib/mock/seed";
import { expectMockDbError, page } from "./utils";

const ACTOR = "e.lindqvist";
const REASON = "Chamber thermocouple read 40 C low for the whole file";
const FILE_ID = FILE_IDS.batCyc;

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

describe("setting the mark", () => {
  it("serves the unflagged block before anybody marks the file", () => {
    expect(getFile(state, FILE_ID, 10).invalid).toEqual({
      flagged: false,
      reason: null,
      actor: null,
      at: null,
    });
  });

  it("writes flagged, reason, actor and timestamp", () => {
    const marked = flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    expect(marked.invalid).toEqual({
      flagged: true,
      reason: REASON,
      actor: ACTOR,
      at: expect.any(String),
    });
    expect(getFile(state, FILE_ID, 10).invalid?.flagged).toBe(true);
  });

  it("strips surrounding whitespace from the reason", () => {
    expect(flagFileInvalid(state, FILE_ID, `  ${REASON}  `, ACTOR).invalid?.reason).toBe(REASON);
  });

  it("stamps the manual provenance of the invalid field", () => {
    const marked = flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    expect(marked.field_sources.invalid).toMatchObject({ source: "manual", actor: ACTOR });
  });

  it("leaves status and the run alone", () => {
    const before = getFile(state, FILE_ID, 10);
    const run = structuredClone(state.runs.find((r) => r.run_id === HERO_RUN_ID));
    const marked = flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    expect(marked.status).toBe(before.status);
    expect(marked.lifecycle).toBe(before.lifecycle);
    expect(state.runs.find((r) => r.run_id === HERO_RUN_ID)).toEqual(run);
  });

  it("marks a quarantined file without ending the quarantine", () => {
    const marked = flagFileInvalid(state, FILE_IDS.emEffQuarantined, REASON, ACTOR);
    expect(marked.status).toBe("quarantined");
    expect(marked.invalid?.flagged).toBe(true);
  });
});

describe("clearing the mark", () => {
  it("empties the block and keeps the file", () => {
    flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    const cleared = clearFileInvalidFlag(state, FILE_ID, "Calibration table was stale, data is good", ACTOR);
    expect(cleared.invalid).toEqual({ flagged: false, reason: null, actor: null, at: null });
    expect(cleared.status).toBe(getFile(state, FILE_ID, 10).status);
  });

  it("lets a second mark follow a clear", () => {
    flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    clearFileInvalidFlag(state, FILE_ID, "false alarm", ACTOR);
    expect(flagFileInvalid(state, FILE_ID, "drift returned", ACTOR).invalid?.flagged).toBe(true);
  });
});

describe("the journal entry", () => {
  it("adds one file.invalid_flag change entry with the reason as note", () => {
    const before = getEntityJournal(state, "file", FILE_ID, undefined, page()).total;
    flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    const journal = getEntityJournal(state, "file", FILE_ID, undefined, page());
    expect(journal.total).toBe(before + 1);
    expect(journal.items.find((j) => j.field === "file.invalid_flag")).toMatchObject({
      entity_type: "file",
      entity_id: FILE_ID,
      kind: "change",
      old: "false",
      new: "true",
      source: "manual",
      actor: ACTOR,
      note: REASON,
    });
  });

  it("keeps both halves, so the history panel shows the way back", () => {
    flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    clearFileInvalidFlag(state, FILE_ID, "sensor was fine after re-check", ACTOR);
    const marks = getFile(state, FILE_ID, 10).ingestion_timeline.filter(
      (j) => j.field === "file.invalid_flag",
    );
    expect(marks.map((j) => [j.old, j.new])).toEqual([
      ["false", "true"],
      ["true", "false"],
    ]);
    expect(marks[1].note).toBe("sensor was fine after re-check");
  });
});

describe("a blank reason (422 reason_required)", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank after strip", "   "],
    ["non-string", 42],
  ])("refuses a %s reason on the set", (_label, reason) => {
    expectMockDbError(() => flagFileInvalid(state, FILE_ID, reason, ACTOR), 422, "reason_required");
  });

  it("refuses a blank reason on the clear as well", () => {
    flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    expectMockDbError(() => clearFileInvalidFlag(state, FILE_ID, "  ", ACTOR), 422, "reason_required");
  });

  it("writes nothing when it refuses", () => {
    const before = state.journal.length;
    expectMockDbError(() => flagFileInvalid(state, FILE_ID, "  ", ACTOR), 422, "reason_required");
    expect(getFile(state, FILE_ID, 10).invalid?.flagged).toBe(false);
    expect(state.journal.length).toBe(before);
  });

  it("refuses a missing actor with 422 validation_error", () => {
    expectMockDbError(() => flagFileInvalid(state, FILE_ID, REASON, undefined), 422, "validation_error");
  });
});

describe("an unknown file (404 file_not_found)", () => {
  it("refuses the set", () => {
    expectMockDbError(() => flagFileInvalid(state, "f-nope", REASON, ACTOR), 404, "file_not_found");
  });

  it("refuses the clear", () => {
    expectMockDbError(() => clearFileInvalidFlag(state, "f-nope", REASON, ACTOR), 404, "file_not_found");
  });
});

describe("the conflicts (409)", () => {
  it("refuses a second set with already_flagged and keeps the first reason", () => {
    flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    expectMockDbError(
      () => flagFileInvalid(state, FILE_ID, "another reason", "a.bergstrom"),
      409,
      "already_flagged",
    );
    expect(getFile(state, FILE_ID, 10).invalid).toMatchObject({ reason: REASON, actor: ACTOR });
  });

  it("refuses a clear on a file nobody marked with not_flagged", () => {
    expectMockDbError(() => clearFileInvalidFlag(state, FILE_ID, REASON, ACTOR), 409, "not_flagged");
  });
});

describe("the list filter", () => {
  it("serves both sides by default, one side on demand", () => {
    const all = listFiles(state, {}, page()).total;
    expect(listFiles(state, { invalid: true }, page()).total).toBe(0);
    flagFileInvalid(state, FILE_ID, REASON, ACTOR);
    expect(listFiles(state, {}, page()).total).toBe(all);
    expect(listFiles(state, { invalid: true }, page()).items.map((f) => f.file_id)).toEqual([FILE_ID]);
    expect(listFiles(state, { invalid: false }, page()).items.map((f) => f.file_id)).not.toContain(FILE_ID);
  });
});
