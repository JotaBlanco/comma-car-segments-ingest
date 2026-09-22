// The custom property map in the mock database, so the dialog works on the
// mock. `api/api/models/runs.py` and `api/api/services/queries_runs.py` hold
// the same rules: the write replaces the whole map, an empty object clears it,
// and each refusal carries its own code.
//
// Config: `vitest.unit.config.ts` takes `tests/unit/**`.

import { beforeEach, describe, expect, it } from "vitest";
import { getDb, getRun, getRunJournal, patchRun, resetDb } from "@/lib/mock/db";
import { HERO_RUN_ID, type MockState } from "@/lib/mock/seed";
import { expectMockDbError, page } from "./utils";

const ACTOR = "s.vidal";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

function propertyEntries() {
  return getRunJournal(state, HERO_RUN_ID, undefined, page()).items.filter(
    (entry) => entry.field === "run.custom_properties",
  );
}

describe("the map on the read", () => {
  it("reads empty on a seeded run", () => {
    expect(getRun(state, HERO_RUN_ID).custom_properties).toEqual({});
  });

  it("reads back what the patch stored", () => {
    patchRun(state, HERO_RUN_ID, { custom_properties: { coolant: "50/50" }, actor: ACTOR });

    expect(getRun(state, HERO_RUN_ID).custom_properties).toEqual({ coolant: "50/50" });
  });
});

describe("the write replaces the whole map", () => {
  it("drops a pair the second write leaves out", () => {
    patchRun(state, HERO_RUN_ID, {
      custom_properties: { coolant: "50/50", "rig serial": "R-9" },
      actor: ACTOR,
    });

    const updated = patchRun(state, HERO_RUN_ID, {
      custom_properties: { coolant: "60/40" },
      actor: ACTOR,
    });

    expect(updated.custom_properties).toEqual({ coolant: "60/40" });
  });

  it("clears every pair on an empty object", () => {
    patchRun(state, HERO_RUN_ID, { custom_properties: { coolant: "50/50" }, actor: ACTOR });

    const updated = patchRun(state, HERO_RUN_ID, { custom_properties: {}, actor: ACTOR });

    expect(updated.custom_properties).toEqual({});
  });

  it("leaves the map alone when the body says nothing about it", () => {
    patchRun(state, HERO_RUN_ID, { custom_properties: { coolant: "50/50" }, actor: ACTOR });

    const updated = patchRun(state, HERO_RUN_ID, { operator: "S. Vidal", actor: ACTOR });

    expect(updated.custom_properties).toEqual({ coolant: "50/50" });
  });

  it("takes the map alone as a real body", () => {
    const updated = patchRun(state, HERO_RUN_ID, {
      custom_properties: { coolant: "50/50" },
      actor: ACTOR,
    });

    expect(updated.custom_properties).toEqual({ coolant: "50/50" });
  });

  it("refuses a body that states nothing at all", () => {
    expectMockDbError(
      () => patchRun(state, HERO_RUN_ID, { actor: ACTOR }),
      400,
      "no_fields_to_update",
    );
  });
});

describe("the write records who changed the map", () => {
  it("tags the field manual with the actor", () => {
    const updated = patchRun(state, HERO_RUN_ID, {
      custom_properties: { coolant: "50/50" },
      actor: ACTOR,
    });

    expect(updated.field_sources.custom_properties).toEqual({
      source: "manual",
      actor: ACTOR,
      at: expect.any(String),
    });
  });

  it("writes one journal entry with the old and the new value", () => {
    patchRun(state, HERO_RUN_ID, { custom_properties: { coolant: "50/50" }, actor: ACTOR });
    patchRun(state, HERO_RUN_ID, { custom_properties: { coolant: "60/40" }, actor: ACTOR });

    const entries = propertyEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "change", source: "manual", actor: ACTOR });
    const latest = entries.find((entry) => entry.new === "coolant=60/40");
    expect(latest?.old).toBe("coolant=50/50");
  });

  it("records a removal, because a removal is a change", () => {
    patchRun(state, HERO_RUN_ID, {
      custom_properties: { coolant: "50/50", "rig serial": "R-9" },
      actor: ACTOR,
    });

    patchRun(state, HERO_RUN_ID, { custom_properties: { coolant: "50/50" }, actor: ACTOR });

    const entries = propertyEntries();
    expect(entries).toHaveLength(2);
    expect(entries.some((entry) => entry.new === "coolant=50/50")).toBe(true);
  });

  it("adds no journal noise when the map does not change", () => {
    patchRun(state, HERO_RUN_ID, { custom_properties: { coolant: "50/50" }, actor: ACTOR });
    patchRun(state, HERO_RUN_ID, {
      custom_properties: { coolant: "50/50" },
      operator: "S. Vidal",
      actor: ACTOR,
    });

    expect(propertyEntries()).toHaveLength(1);
  });
});

describe("the refusals", () => {
  it("refuses an empty name", () => {
    expectMockDbError(
      () => patchRun(state, HERO_RUN_ID, { custom_properties: { "": "R-9" }, actor: ACTOR }),
      422,
      "custom_property_key_required",
    );
  });

  it("refuses a name of only spaces", () => {
    expectMockDbError(
      () => patchRun(state, HERO_RUN_ID, { custom_properties: { "   ": "R-9" }, actor: ACTOR }),
      422,
      "custom_property_key_required",
    );
  });

  it("refuses a name over 64 characters", () => {
    expectMockDbError(
      () =>
        patchRun(state, HERO_RUN_ID, { custom_properties: { ["k".repeat(65)]: "R-9" }, actor: ACTOR }),
      422,
      "custom_property_key_too_long",
    );
  });

  it("refuses a value over 512 characters", () => {
    expectMockDbError(
      () =>
        patchRun(state, HERO_RUN_ID, {
          custom_properties: { note: "v".repeat(513) },
          actor: ACTOR,
        }),
      422,
      "custom_property_value_too_long",
    );
  });

  it("refuses more than 50 pairs", () => {
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_unused, index) => [`k${index}`, "v"]),
    );

    expectMockDbError(
      () => patchRun(state, HERO_RUN_ID, { custom_properties: many, actor: ACTOR }),
      422,
      "too_many_custom_properties",
    );
  });

  it("takes exactly 50 pairs", () => {
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_unused, index) => [`k${index}`, "v"]),
    );

    expect(
      Object.keys(patchRun(state, HERO_RUN_ID, { custom_properties: many, actor: ACTOR })
        .custom_properties),
    ).toHaveLength(50);
  });

  it("keeps the stored map after a refusal", () => {
    patchRun(state, HERO_RUN_ID, { custom_properties: { coolant: "50/50" }, actor: ACTOR });

    expectMockDbError(
      () => patchRun(state, HERO_RUN_ID, { custom_properties: { "": "R-9" }, actor: ACTOR }),
      422,
      "custom_property_key_required",
    );
    expect(getRun(state, HERO_RUN_ID).custom_properties).toEqual({ coolant: "50/50" });
  });
});
