/**
 * `independentKeys` — a filter that stands beside the quick views, not among them.
 *
 * A quick view is exclusive: it rewrites every configured key and it matches on
 * set-equality over every configured key. The files screen's "Hide invalid" must
 * not obey either rule, because a person wants the registered files WITHOUT the
 * invalid ones. Both filters have to hold at once.
 *
 * Config: `vitest.unit.config.ts` takes `tests/unit/**`.
 */
import { describe, expect, it } from "vitest";
import {
  applyFilterValues,
  buildTableQuery,
  parseTableState,
  resolveQuickView,
  type TableStateConfig,
  type TableUrlState,
} from "@/lib/table-state";

/** The real files-screen shape, trimmed to what these tests exercise. */
const CONFIG: TableStateConfig = {
  multiKeys: ["status", "lifecycle"],
  singleKeys: ["run", "invalid"],
  sortKeys: ["registered_at"],
  defaultSort: { key: "registered_at", order: "desc" },
  defaultPageSize: 20,
  pageSizeOptions: [20, 50],
  quickViews: [
    { id: "all", params: {} },
    { id: "registered", params: { status: ["registered"] } },
    { id: "archived", params: { lifecycle: ["archived"] } },
  ],
  independentKeys: ["invalid"],
};

function parse(search: string): TableUrlState {
  return parseTableState(new URLSearchParams(search), CONFIG);
}

describe("a quick view leaves an independent key alone", () => {
  it("still resolves All when only the independent key is set", () => {
    expect(resolveQuickView(parse("invalid=false"), CONFIG)).toBe("all");
  });

  it("still resolves a named view when the independent key rides along", () => {
    expect(resolveQuickView(parse("status=registered&invalid=false"), CONFIG)).toBe("registered");
  });

  it("drops the highlight for a key the views DO own, so the exemption is narrow", () => {
    // `run` is an ordinary single key. It must still break preset equality.
    expect(resolveQuickView(parse("run=TAS-1"), CONFIG)).toBeNull();
  });
});

describe("the canonical query carries the independent key", () => {
  it("emits invalid=false, so a saved search keeps the filter", () => {
    // `SavedSearchButton` stores exactly this string, so what lands here is
    // what a saved search replays.
    expect(buildTableQuery(parse("invalid=false"), CONFIG)).toBe("?invalid=false");
  });

  it("emits it beside a view's own key", () => {
    expect(buildTableQuery(parse("status=registered&invalid=false"), CONFIG)).toBe(
      "?status=registered&invalid=false",
    );
  });

  it("emits nothing when the key is absent, so the default URL stays bare", () => {
    expect(buildTableQuery(parse(""), CONFIG)).toBe("");
  });
});

describe("the key clears the ordinary way", () => {
  it("an empty array removes it", () => {
    const cleared = applyFilterValues(parse("invalid=false"), "invalid", [], CONFIG);
    expect(cleared.single.invalid).toBeUndefined();
    expect(buildTableQuery(cleared, CONFIG)).toBe("");
  });

  it("round-trips true as well as false, so a deep link is not rewritten", () => {
    expect(parse("invalid=true").single.invalid).toBe("true");
    expect(buildTableQuery(parse("invalid=true"), CONFIG)).toBe("?invalid=true");
  });
});
