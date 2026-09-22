/**
 * Explore tab — workbench tab strip behavior (replaces the mode-segment
 * suite; the three-way segment became N tabs + a "+" menu).
 *
 *  - seeds one "SQL query 1" tab, selected
 *  - "+" menu lists SQL query / Visualisation; Ask AI appears ONLY when
 *    context.ai_available is true (with the mock backend it is false)
 *  - creating and closing tabs stays out of the URL
 *  - the scope strip still shows the locked run_id chip and lakeside badges
 *  - restoring persisted tabs fires no query for hidden panes (lazy mount)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExploreContext, FileSignal, Paginated } from "@/types";
import { resolveLakeSchema, setLakeTable } from "@/lib/explore/lake-schema";
import { TABS_VERSION, tabsStorageKey } from "@/lib/explore/tabs";
import { buildSeedSql } from "@/lib/explore/viz-sql";

// Keep Chart.js out of the jsdom run — the viz panel is not under test here.
vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => null;
    return Stub;
  },
}));

import { ExploreTab } from "@/components/screens/run-detail/explore-tab/explore-tab";
import { exploreApi } from "@/lib/api/explore";
import { directLakeApi } from "@/lib/api/lake";
import { runsApi } from "@/lib/api/runs";

const RUN = "TAS-88214";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset the module-level lake table a test may have configured.
  setLakeTable("");
});

function context(overrides: Partial<ExploreContext> = {}): ExploreContext {
  return {
    table: "test_signal_samples",
    columns: ["run_id", "signal", "timestamp", "value", "filename"],
    file_count: 3,
    signal_count: 142,
    sample_count: 140_032,
    ai_available: false,
    ...overrides,
  };
}

function signalsPage(): Paginated<FileSignal> {
  const signal = (name: string): FileSignal => ({
    name,
    unit: "°C",
    unit_source: "embedded",
    rate_hz: 100,
    dtype: "float64",
    stats: { min: 18.2, max: 47.9, mean: 33.4, std: 6.21 },
  });
  return {
    items: [signal("HV_Batt_Cell_Temp_Max"), signal("Coolant_Inlet_Temp")],
    total: 2,
    page: 1,
    page_size: 200,
    total_pages: 1,
  };
}

function renderTab(ctx: ExploreContext) {
  vi.spyOn(exploreApi, "context").mockResolvedValue(ctx);
  vi.spyOn(runsApi, "signals").mockResolvedValue(signalsPage());
  const querySpy = vi
    .spyOn(directLakeApi, "query")
    .mockImplementation(() => new Promise(() => undefined));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ExploreTab runId={RUN} focus={false} onToggleFocus={() => undefined} />
    </QueryClientProvider>,
  );
  return { view, querySpy };
}

describe("ExploreTab — workbench tabs", () => {
  it("seeds one selected SQL tab", async () => {
    renderTab(context());
    const tab = await screen.findByRole("tab", { name: /SQL query 1/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("offers SQL and Visualisation in the + menu, hiding Ask AI without an agent", async () => {
    const user = userEvent.setup();
    renderTab(context({ ai_available: false }));
    await screen.findByRole("tab", { name: /SQL query 1/ });
    await user.click(screen.getByRole("button", { name: "New tab" }));
    expect(await screen.findByRole("menuitem", { name: /SQL query/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Visualisation/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Ask AI/ })).not.toBeInTheDocument();
  });

  it("offers Ask AI when the context reports an agent", async () => {
    const user = userEvent.setup();
    renderTab(context({ ai_available: true }));
    await screen.findByRole("tab", { name: /SQL query 1/ });
    await user.click(screen.getByRole("button", { name: "New tab" }));
    expect(await screen.findByRole("menuitem", { name: /Ask AI/ })).toBeInTheDocument();
  });

  it("creates and activates a tab from the + menu without touching the URL", async () => {
    const user = userEvent.setup();
    renderTab(context());
    await screen.findByRole("tab", { name: /SQL query 1/ });
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await user.click(await screen.findByRole("menuitem", { name: /Visualisation/ }));

    const vizTab = screen.getByRole("tab", { name: /Visualisation 1/ });
    expect(vizTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /SQL query 1/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(window.location.search).toBe("");
  });

  it("speaks the server-configured PHYSICAL table, never context.table", async () => {
    // The context still reports the LOGICAL name (`test_signal_samples`) —
    // the workbench must ignore it for SQL building and use the physical
    // table the server read from TM_LAKE_TABLE.
    setLakeTable("test_signal_samples_v3");
    const user = userEvent.setup();
    renderTab(context());
    await screen.findByRole("tab", { name: /SQL query 1/ });

    // The bootstrap seed upgrades to the physical spellings + run scope.
    await waitFor(() => {
      const editor = screen.getByLabelText("SQL editor") as HTMLTextAreaElement;
      expect(editor.value).toContain("FROM test_signal_samples_v3");
      expect(editor.value).toContain("ts_ms");
      expect(editor.value).toContain(`WHERE run_id = '${RUN}'`);
      expect(editor.value).not.toContain("timestamp");
    });

    // The schema rail shows the same physical table and spellings.
    await user.click(screen.getByRole("button", { name: "Schema" }));
    const rail = screen.getByRole("region", { name: "Schema" });
    expect(within(rail).getByText("test_signal_samples_v3")).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /ts_ms/ })).toHaveTextContent("epoch ms");
    expect(within(rail).getByRole("button", { name: /file_name/ })).toBeInTheDocument();
  });

  it("upgrades a stale physical seed after a TM_LAKE_TABLE repoint — but never edited SQL", async () => {
    // A previous visit minted the seed for the OLD physical table; this
    // deployment now points at v3. The untouched seed upgrades, the SQL a
    // person edited stays byte-identical.
    const staleSeed = buildSeedSql(resolveLakeSchema("test_signal_samples"), RUN);
    localStorage.setItem(
      tabsStorageKey(RUN),
      JSON.stringify({
        v: TABS_VERSION,
        tabs: [
          { id: "a", kind: "sql", title: "SQL query 1" },
          { id: "b", kind: "sql", title: "SQL query 2" },
        ],
        activeId: "a",
        sqlByTab: { a: staleSeed, b: "SELECT count(*) FROM test_signal_samples" },
      }),
    );
    setLakeTable("test_signal_samples_v3");
    renderTab(context());
    await screen.findByRole("tab", { name: /SQL query 1/ });

    await waitFor(() => {
      const editor = screen.getByLabelText("SQL editor") as HTMLTextAreaElement;
      expect(editor.value).toBe(buildSeedSql(resolveLakeSchema("test_signal_samples_v3"), RUN));
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /SQL query 2/ }));
    await waitFor(() => {
      const editors = screen.getAllByLabelText("SQL editor") as HTMLTextAreaElement[];
      expect(editors.some((el) => el.value === "SELECT count(*) FROM test_signal_samples")).toBe(
        true,
      );
    });
  });

  it("upgrades a seed minted while the current table was still unmapped", async () => {
    // `tm_signals` joined PHYSICAL_COLUMN_SPELLINGS only after it shipped.
    // A browser that opened Explore before that holds a seed with the
    // identity spellings `timestamp` / `filename` and the RIGHT table name.
    // That seed names columns the table does not have, so the lake answers a
    // binder error. It must upgrade like any other stale seed.
    const unmappedSchema = { ...resolveLakeSchema("test_signal_samples"), table: "tm_signals" };
    const staleSeed = buildSeedSql(unmappedSchema, RUN);
    expect(staleSeed).toContain("FROM tm_signals");
    expect(staleSeed).toContain("timestamp");
    localStorage.setItem(
      tabsStorageKey(RUN),
      JSON.stringify({
        v: TABS_VERSION,
        tabs: [{ id: "a", kind: "sql", title: "SQL query 1" }],
        activeId: "a",
        sqlByTab: { a: staleSeed },
      }),
    );
    setLakeTable("tm_signals");
    renderTab(context());
    await screen.findByRole("tab", { name: /SQL query 1/ });

    await waitFor(() => {
      const editor = screen.getByLabelText("SQL editor") as HTMLTextAreaElement;
      expect(editor.value).toBe(buildSeedSql(resolveLakeSchema("tm_signals"), RUN));
    });
  });

  it("leaves SQL a person edited byte-identical, even on the unmapped-seed path", async () => {
    // One character away from the identity-fallback seed for `tm_signals`.
    // The set holds exact strings only, so this near-miss never upgrades.
    const unmappedSchema = { ...resolveLakeSchema("test_signal_samples"), table: "tm_signals" };
    const edited = `${buildSeedSql(unmappedSchema, RUN)}0`;
    localStorage.setItem(
      tabsStorageKey(RUN),
      JSON.stringify({
        v: TABS_VERSION,
        tabs: [{ id: "a", kind: "sql", title: "SQL query 1" }],
        activeId: "a",
        sqlByTab: { a: edited },
      }),
    );
    setLakeTable("tm_signals");
    renderTab(context());
    await screen.findByRole("tab", { name: /SQL query 1/ });

    const editor = screen.getByLabelText("SQL editor") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(edited));
    // Give the upgrade effect every chance to fire, then re-assert.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(editor.value).toBe(edited);
  });

  it("renders the locked scope chip with lakeside counts", async () => {
    renderTab(context());
    expect(await screen.findByText(`run_id = '${RUN}'`)).toBeInTheDocument();
    expect(screen.getByText("computed lakeside")).toBeInTheDocument();
    expect(screen.getByText("read-only")).toBeInTheDocument();
    expect(screen.getByText("140,032 samples")).toBeInTheDocument();
  });

  it("a tab created from the + menu starts empty with the editor placeholder", async () => {
    const user = userEvent.setup();
    renderTab(context());
    await screen.findByRole("tab", { name: /SQL query 1/ });
    // The bootstrap tab carries the seed query…
    const [bootstrapEditor] = screen.getAllByLabelText("SQL editor");
    expect(bootstrapEditor).not.toHaveValue("");

    // …an explicitly created tab does not.
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await user.click(await screen.findByRole("menuitem", { name: /SQL query/ }));
    const editors = screen.getAllByLabelText("SQL editor");
    const fresh = editors[editors.length - 1];
    expect(fresh).toHaveValue("");
    expect(fresh).toHaveAttribute("placeholder", expect.stringMatching(/SQL query/));
  });

  it("shows the Schema toggle only on SQL tabs, preserving the open state across a viz detour", async () => {
    const user = userEvent.setup();
    renderTab(context());
    await screen.findByRole("tab", { name: /SQL query 1/ });

    // The rail docks at the host level, like the history panel.
    await user.click(screen.getByRole("button", { name: "Schema" }));
    expect(screen.getByRole("button", { name: "Schema" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Schema" })).toBeInTheDocument();

    // On a Visualisation tab the toggle AND the docked rail disappear entirely.
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await user.click(await screen.findByRole("menuitem", { name: /Visualisation/ }));
    expect(screen.queryByRole("button", { name: "Schema" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Schema" })).not.toBeInTheDocument();

    // Back on the SQL tab both return, still open.
    await user.click(screen.getByRole("tab", { name: /SQL query 1/ }));
    expect(screen.getByRole("button", { name: "Schema" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Schema" })).toBeInTheDocument();
  });

  it("renames a tab inline — double-click, Enter commits, Delete types instead of closing", async () => {
    const user = userEvent.setup();
    renderTab(context());
    await screen.findByRole("tab", { name: /SQL query 1/ });
    // A second tab so a leaked Delete keydown COULD close one if unguarded.
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await user.click(await screen.findByRole("menuitem", { name: /SQL query/ }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    await user.dblClick(screen.getByRole("tab", { name: /SQL query 1/ }));
    expect(screen.getByRole("textbox", { name: "Rename tab" })).toBeInTheDocument();
    /* While the input exists the strip drops its tablist/tab roles (an
       interactive role must not contain a focusable descendant, and a tablist
       may only contain tabs — axe nested-interactive / aria-required-children).
       Both tab titles must still be rendered. */
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByText("SQL query 2")).toBeInTheDocument();
    // Delete edits the draft (select-all on focus makes it clear the field);
    // it must never bubble out and close the tab.
    await user.keyboard("{Delete}");
    expect(screen.getByRole("textbox", { name: "Rename tab" })).toBeInTheDocument();

    await user.keyboard("traction study{Enter}");
    // Roles return the moment editing ends.
    expect(await screen.findByRole("tab", { name: /traction study/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Rename tab" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("F2 opens rename and Escape cancels without changing the title", async () => {
    const user = userEvent.setup();
    renderTab(context());
    const tab = await screen.findByRole("tab", { name: /SQL query 1/ });
    tab.focus();
    await user.keyboard("{F2}");
    expect(screen.getByRole("textbox", { name: "Rename tab" })).toBeInTheDocument();
    await user.keyboard("scrapped{Escape}");
    expect(screen.getByRole("tab", { name: /SQL query 1/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Rename tab" })).not.toBeInTheDocument();
  });

  it("schema click-to-insert lands in the active SQL tab's editor", async () => {
    const user = userEvent.setup();
    renderTab(context());
    await screen.findByRole("tab", { name: /SQL query 1/ });
    await user.click(screen.getByRole("button", { name: "Schema" }));

    const rail = screen.getByRole("region", { name: "Schema" });
    await user.click(within(rail).getByRole("button", { name: /Coolant_Inlet_Temp/ }));

    await waitFor(() => {
      const editor = screen.getByLabelText("SQL editor") as HTMLTextAreaElement;
      expect(editor.value).toContain("'Coolant_Inlet_Temp'");
    });
  });

  it("surfaces a signals fetch failure as an error state with retry", async () => {
    vi.spyOn(exploreApi, "context").mockResolvedValue(context());
    vi.spyOn(runsApi, "signals").mockRejectedValue(new Error("boom"));
    vi.spyOn(directLakeApi, "query").mockImplementation(() => new Promise(() => undefined));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ExploreTab runId={RUN} focus={false} onToggleFocus={() => undefined} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Could not load this run's signals/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  /** Persist a known multi-tab layout so reorder tests start deterministic. */
  function seedStoredTabs(activeId: string) {
    localStorage.setItem(
      tabsStorageKey(RUN),
      JSON.stringify({
        v: TABS_VERSION,
        tabs: [
          { id: "a", kind: "sql", title: "SQL query 1" },
          { id: "b", kind: "sql", title: "SQL query 2" },
          { id: "c", kind: "viz", title: "Visualisation 1" },
        ],
        activeId,
        sqlByTab: { a: "SELECT 1", b: "SELECT 2" },
      }),
    );
  }

  function tabTitles(): string[] {
    return screen.getAllByRole("tab").map((tab) => tab.getAttribute("title") ?? "");
  }

  it("Ctrl+ArrowRight moves the focused tab right, keeps its focus and selection", async () => {
    seedStoredTabs("a");
    const user = userEvent.setup();
    renderTab(context());
    const tab = await screen.findByRole("tab", { name: /SQL query 1/ });
    tab.focus();
    await user.keyboard("{Control>}{ArrowRight}{/Control}");

    expect(tabTitles()).toEqual(["SQL query 2", "SQL query 1", "Visualisation 1"]);
    // The move re-parents the keyed button — the roving tabindex chain must
    // land back on the moved tab, still the selected one.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /SQL query 1/ })).toHaveFocus(),
    );
    expect(screen.getByRole("tab", { name: /SQL query 1/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // And back left; at the left edge a further Ctrl+ArrowLeft is a no-op.
    await user.keyboard("{Control>}{ArrowLeft}{ArrowLeft}{/Control}");
    expect(tabTitles()).toEqual(["SQL query 1", "SQL query 2", "Visualisation 1"]);
  });

  it("dragging a tab past the threshold reorders and swallows the trailing click", async () => {
    seedStoredTabs("b");
    renderTab(context());
    const tab = await screen.findByRole("tab", { name: /SQL query 1/ });

    // jsdom rects are all zero-width, so every sibling center sits at 0 and a
    // +40px travel reads as "past everything" — dragging tab a to the end.
    fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 10 });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 50 });
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 50 });

    expect(tabTitles()).toEqual(["SQL query 2", "Visualisation 1", "SQL query 1"]);
    // The pointerup's synthesised click is a drop, not an activate — the
    // dragged (inactive) tab must NOT steal selection from tab b.
    fireEvent.click(screen.getByRole("tab", { name: /SQL query 1/ }));
    expect(screen.getByRole("tab", { name: /SQL query 1/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tab", { name: /SQL query 2/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("a press that stays under the drag threshold is a plain activating click", async () => {
    seedStoredTabs("a");
    renderTab(context());
    const tab = await screen.findByRole("tab", { name: /SQL query 2/ });

    fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 10 });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 12 }); // < 4px — no drag
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 12 });
    fireEvent.click(tab);

    expect(tabTitles()).toEqual(["SQL query 1", "SQL query 2", "Visualisation 1"]);
    expect(tab).toHaveAttribute("aria-selected", "true");
  });

  it("restores persisted tabs without firing queries for hidden panes", async () => {
    localStorage.setItem(
      tabsStorageKey(RUN),
      JSON.stringify({
        v: TABS_VERSION,
        tabs: [
          { id: "a", kind: "sql", title: "SQL query 1" },
          { id: "b", kind: "sql", title: "SQL query 2" },
          { id: "c", kind: "viz", title: "Visualisation 1" },
        ],
        activeId: "a",
        sqlByTab: { a: "SELECT 1", b: "SELECT 2" },
      }),
    );
    const { querySpy } = renderTab(context());
    expect(await screen.findAllByRole("tab")).toHaveLength(3);
    // Lazy mount: the hidden SQL tab renders nothing and the restored viz tab
    // must NOT auto-fire a lake query nobody asked for.
    expect(querySpy).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /SQL query 1/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
