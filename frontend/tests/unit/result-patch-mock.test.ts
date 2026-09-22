/**
 * The mock half of `PATCH /results/{result_id}`.
 *
 * The rules asserted here are copied from `patch_result` in
 * `api/api/routers/results.py` — when one side changes, this suite is the
 * tripwire for the mock.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb, patchResult, resetDb } from "@/lib/mock/db";
import { MockDbError } from "@/lib/mock/errors";
import { FILE_IDS, HERO_RUN_ID } from "@/lib/mock/seed";
import type { MockState } from "@/lib/mock/seed";
import type { ProcessedResult } from "@/types";

let state: MockState;
let seeded: ProcessedResult;

beforeEach(() => {
  resetDb();
  state = getDb();
  seeded = state.results[0];
});

const ACTOR = "e.lindqvist";

function errorOf(fn: () => unknown): MockDbError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MockDbError) return error;
    throw error;
  }
  throw new Error("expected a MockDbError");
}

describe("a legal edit", () => {
  it("writes the fields, journals each change on the run, and raises the edited mark", () => {
    const before = state.journal.length;
    const patched = patchResult(state, seeded.result_id, {
      name: "thermal_summary_v1_final.parquet",
      provenance: { tool: "bat-post-x" },
      actor: ACTOR,
      note: "wrong tool name",
    });

    expect(patched.name).toBe("thermal_summary_v1_final.parquet");
    expect(patched.provenance.tool).toBe("bat-post-x");
    expect(patched.edited).toEqual({
      at: expect.any(String),
      actor: ACTOR,
      fields: ["result.name", "result.provenance.tool"],
    });

    const entries = state.journal.slice(before);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.entity_type).toBe("result");
      expect(entry.entity_id).toBe(seeded.result_id);
      expect(entry.kind).toBe("change");
      expect(entry.source).toBe("manual");
      expect(entry.actor).toBe(ACTOR);
      expect(entry.note).toBe("wrong tool name");
      expect(entry.context_run_id).toBe(HERO_RUN_ID);
    }
    expect(entries.map((e) => e.field).sort()).toEqual(["result.name", "result.provenance.tool"]);
  });

  it("writes nothing for a restated value — no entry, no mark", () => {
    const before = state.journal.length;
    const patched = patchResult(state, seeded.result_id, {
      name: seeded.name,
      // The stored instant, restated with millisecond digits. Not a change.
      provenance: { produced_at: "2026-08-14T12:02:00.000Z" },
      actor: ACTOR,
    });
    expect(state.journal.length).toBe(before);
    expect(patched.edited ?? null).toBeNull();
  });

  it("a changed input list re-derives provenance_status without an entry of its own", () => {
    const before = state.journal.length;
    const flagged = patchResult(state, seeded.result_id, {
      provenance: { input_file_ids: ["f-nobody-knows-this-id"] },
      actor: ACTOR,
    });
    expect(flagged.provenance_status).toBe("flagged");
    // One entry for the list change. The derived status journals nothing.
    expect(state.journal.length).toBe(before + 1);

    const restored = patchResult(state, seeded.result_id, {
      provenance: { input_file_ids: [FILE_IDS.batCyc, FILE_IDS.chamberLog] },
      actor: ACTOR,
    });
    expect(restored.provenance_status).toBe("verified");
  });
});

describe("the refusals the real route answers", () => {
  it("404 result_not_found for an unknown id", () => {
    const error = errorOf(() => patchResult(state, "res-nope", { name: "x", actor: ACTOR }));
    expect(error.status).toBe(404);
    expect(error.code).toBe("result_not_found");
  });

  it("400 no_fields_to_update when the body states no field", () => {
    const error = errorOf(() => patchResult(state, seeded.result_id, { actor: ACTOR, note: "hi" }));
    expect(error.status).toBe(400);
    expect(error.code).toBe("no_fields_to_update");
  });

  it("422 for a minted or derived key — and the body 422 beats the 404", () => {
    // The real body model forbids the key before the route runs, so even an
    // unknown id answers 422, never 404.
    const error = errorOf(() => patchResult(state, "res-nope", { version: 2, actor: ACTOR }));
    expect(error.status).toBe(422);
    expect(error.code).toBe("validation_error");
  });

  it("422 provenance_required for a stated blank value", () => {
    const error = errorOf(() =>
      patchResult(state, seeded.result_id, { provenance: { tool: "  " }, actor: ACTOR }),
    );
    expect(error.status).toBe(422);
    expect(error.code).toBe("provenance_required");
  });

  it("422 for an actor that names nobody", () => {
    for (const actor of [undefined, "  ", "current-user"]) {
      const error = errorOf(() => patchResult(state, seeded.result_id, { name: "x", actor }));
      expect(error.status).toBe(422);
      expect(error.code).toBe("validation_error");
    }
  });

  it("422 for an unknown provenance key and for a bad produced_at", () => {
    expect(
      errorOf(() =>
        patchResult(state, seeded.result_id, { provenance: { vibe: "good" }, actor: ACTOR }),
      ).code,
    ).toBe("validation_error");
    expect(
      errorOf(() =>
        patchResult(state, seeded.result_id, { provenance: { produced_at: "yesterday" }, actor: ACTOR }),
      ).code,
    ).toBe("validation_error");
  });

  it("a null field counts as absent — it never clears a value", () => {
    const error = errorOf(() =>
      patchResult(state, seeded.result_id, { name: null, description: null, actor: ACTOR }),
    );
    expect(error.code).toBe("no_fields_to_update");
    expect(seeded.name).toBe("thermal_summary_v1.parquet");
  });
});
