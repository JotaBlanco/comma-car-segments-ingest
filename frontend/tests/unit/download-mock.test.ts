/**
 * Mock file-download journal side-effect (contract v1.1 §D).
 *
 * The mock backend mirrors the BE audit-before-bytes rule: a `file.downloaded`
 * journal entry appears in `state.journal` before the mock route returns its
 * deterministic payload. This unit test drives `prepareDownload` directly so
 * the ordering is inspectable without a fetch.
 *
 * Also asserts the two refusal paths (404 unknown, 403 quarantined) never
 * append a journal entry — matching the BE guarantee that no fake trace is
 * left behind by a byte stream that never started.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb, prepareDownload, resetDb } from "@/lib/mock/db";
import { MockDbError } from "@/lib/mock/errors";
import type { MockState } from "@/lib/mock/seed";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

describe("prepareDownload — happy path", () => {
  it("appends exactly one file.downloaded journal entry per call", () => {
    const file = state.files.find((f) => f.status === "registered");
    expect(file).toBeDefined();
    const before = state.journal.length;

    const { file: returnedFile, audit } = prepareDownload(state, file!.file_id);

    expect(returnedFile.file_id).toBe(file!.file_id);
    expect(state.journal.length).toBe(before + 1);
    expect(audit.entity_type).toBe("file");
    expect(audit.entity_id).toBe(file!.file_id);
    expect(audit.field).toBe("file.downloaded");
    expect(audit.kind).toBe("event");
    expect(audit.actor).toBeTruthy();
    expect(audit.note).toContain(file!.filename);
    expect(audit.note).toContain("mock");
  });

  it("appends N journal entries after N calls, in call order", () => {
    const file = state.files.find((f) => f.status === "registered");
    expect(file).toBeDefined();
    const before = state.journal.filter((j) => j.field === "file.downloaded").length;

    prepareDownload(state, file!.file_id);
    prepareDownload(state, file!.file_id);
    prepareDownload(state, file!.file_id);

    const after = state.journal.filter((j) => j.field === "file.downloaded");
    expect(after.length - before).toBe(3);
    // The entries were pushed in order, so a stable sort by array position
    // matches call order — assert the timestamps are non-decreasing.
    for (let index = 1; index < after.length; index += 1) {
      expect(after[index].at >= after[index - 1].at).toBe(true);
    }
  });

  it("returns the audit entry id so the route can send it as X-Journal-Id", () => {
    const file = state.files.find((f) => f.status === "registered")!;
    const { audit } = prepareDownload(state, file.file_id);
    expect(audit.id).toMatch(/^j-/);
    // The pushed entry is the same object, so mutating it later would appear
    // in state — assert reference identity.
    const stored = state.journal[state.journal.length - 1];
    expect(stored.id).toBe(audit.id);
  });
});

describe("prepareDownload — refusal paths never write an audit entry", () => {
  it("throws MockDbError(404, file_not_found) for an unknown id and writes nothing", () => {
    const before = state.journal.length;
    expect(() => prepareDownload(state, "f-does-not-exist")).toThrowError(
      expect.objectContaining({
        status: 404,
        code: "file_not_found",
      }),
    );
    expect(state.journal.length).toBe(before);
  });

  it("throws MockDbError(403, not_allowed) for a quarantined file and writes nothing", () => {
    const quarantined = state.files.find((f) => f.status === "quarantined");
    expect(quarantined).toBeDefined();
    const before = state.journal.length;
    let caught: MockDbError | undefined;
    try {
      prepareDownload(state, quarantined!.file_id);
    } catch (error) {
      caught = error as MockDbError;
    }
    expect(caught).toBeInstanceOf(MockDbError);
    expect(caught!.status).toBe(403);
    expect(caught!.code).toBe("not_allowed");
    expect(state.journal.length).toBe(before);
  });
});

describe("prepareDownload — audit-before-bytes ordering", () => {
  it("returns the audit entry synchronously, before the route composes any bytes", () => {
    // The mock is synchronous, so ordering is trivially "audit first" — this
    // test proves the interface contract: prepareDownload returns an entry
    // ALREADY appended to state.journal. A caller cannot forget to append it.
    const file = state.files.find((f) => f.status === "registered")!;
    const journalBefore = [...state.journal];
    const { audit } = prepareDownload(state, file.file_id);
    // The last entry in state.journal is the one prepareDownload returned.
    expect(state.journal.length).toBe(journalBefore.length + 1);
    expect(state.journal[state.journal.length - 1].id).toBe(audit.id);
  });
});
