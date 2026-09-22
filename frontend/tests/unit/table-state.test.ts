// `setFilterValues` on single-value keys (the pure half, `applyFilterValues`).
//
// The filter pills remove a single-key filter (`signal`, `definition`, `run`,
// `unlinked`…) by calling `setFilterValues(key, [])`. The hook used to return
// early for every key outside `multiKeys`, so those pills removed nothing —
// the ✕ clicked and the URL stood still. These tests pin the repaired rule:
// a single-key takes `values[0]`, an empty array clears it to `undefined`,
// and the multi-key path keeps working exactly as before.

import { describe, expect, it } from "vitest";
import {
  applyFilterValues,
  buildTableQuery,
  parseTableState,
  type TableStateConfig,
  type TableUrlState,
} from "@/lib/table-state";

/** The shape the files screen uses — multi keys plus two single keys. */
const CONFIG: TableStateConfig = {
  multiKeys: ["status", "source"],
  singleKeys: ["run", "unlinked"],
  sortKeys: ["registered_at"],
  defaultSort: { key: "registered_at", order: "desc" },
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100, 200, 500],
  quickViews: [{ id: "all", params: {} }],
};

function stateFrom(query: string): TableUrlState {
  return parseTableState(new URLSearchParams(query), CONFIG);
}

describe("applyFilterValues on a single-value key", () => {
  it("sets values[0] into state.single", () => {
    const next = applyFilterValues(stateFrom(""), "run", ["TAS-90001"], CONFIG);
    expect(next.single.run).toBe("TAS-90001");
  });

  it("clears the key to undefined on an empty array — the pill's ✕", () => {
    const state = stateFrom("run=TAS-90001");
    expect(state.single.run).toBe("TAS-90001");
    const next = applyFilterValues(state, "run", [], CONFIG);
    expect(next.single.run).toBeUndefined();
    // The cleared key leaves the URL entirely.
    expect(buildTableQuery(next, CONFIG)).toBe("");
  });

  it("leaves every other key alone", () => {
    const state = stateFrom("run=TAS-90001&unlinked=true&status=quarantined");
    const next = applyFilterValues(state, "run", [], CONFIG);
    expect(next.single.unlinked).toBe("true");
    expect(next.multi.status).toEqual(["quarantined"]);
  });
});

describe("applyFilterValues on a multi-value key", () => {
  it("replaces the whole array, as before", () => {
    const state = stateFrom("status=registered");
    const next = applyFilterValues(state, "status", ["quarantined", "registered"], CONFIG);
    expect(next.multi.status).toEqual(["quarantined", "registered"]);
  });

  it("clears the key on an empty array", () => {
    const state = stateFrom("status=registered");
    const next = applyFilterValues(state, "status", [], CONFIG);
    expect(next.multi.status).toEqual([]);
    expect(buildTableQuery(next, CONFIG)).toBe("");
  });
});

describe("applyFilterValues on a key the config never named", () => {
  it("returns the state unchanged — same reference, so the hook pushes no URL", () => {
    const state = stateFrom("run=TAS-90001");
    expect(applyFilterValues(state, "nonsense", ["x"], CONFIG)).toBe(state);
  });
});
