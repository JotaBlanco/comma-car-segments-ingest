/**
 * The sessions dialog over the LAKE's partition tree: the folders come from
 * the lake one level at a time, the Test Manager decorates them, and the
 * sessions under the folder picked are the lake's own values, ticked one at a
 * time until Multiple sessions is turned on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workbooks",
  useSearchParams: () => new URLSearchParams(),
}));

/* One small estate, in the shape the default variables state:
   platform / work_order / test_definition / run_id. */
const { lake, asked } = vi.hoisted(() => ({
  lake: {
    levels: {
      "": ["platform=AC3", "platform=AC2"],
      "platform=AC3": ["work_order=WO-1", "work_order=__None__"],
      "platform=AC3/work_order=WO-1": ["test_definition=TD-1"],
    } as Record<string, string[]>,
    sessions: {
      "{}": ["r1", "r2", "r3"],
      '{"platform":"AC3"}': ["r1", "r3"],
      '{"platform":"AC3","work_order":"WO-1"}': ["r1"],
    } as Record<string, string[]>,
  },
  asked: { levels: [] as string[], sessions: [] as Record<string, string>[], runs: [] as Record<string, unknown>[] },
}));

const RUNS = [
  { run_id: "r1", definition_id: "TD-1", rig_id: "sn003", test_cell: null, first_data_at: "2026-01-03T10:00:00Z", file_count: 1, signal_count: 2, status: "complete" },
  { run_id: "r2", definition_id: null, rig_id: "sn002", test_cell: null, first_data_at: "2026-01-02T09:00:00Z", file_count: 1, signal_count: 2, status: "awaiting_work_order" },
];

vi.mock("@/lib/hooks", () => ({
  useWorkOrders: () => ({
    data: { items: [{ wo_id: "WO-1", title: "Fleet — data pipeline acceptance" }] },
    isPending: false,
    isError: false,
  }),
  useTestDefinitions: () => ({
    data: { items: [{ td_id: "TD-1", title: "High-rate DAQ survey" }] },
    isPending: false,
    isError: false,
  }),
  useLakeLevel: (path: string) => {
    asked.levels.push(path);
    const partitions = lake.levels[path];
    return {
      data: partitions === undefined ? undefined : { partitions: partitions.map((name) => ({ name, path: path === "" ? name : `${path}/${name}` })) },
      isPending: partitions === undefined,
      isError: false,
      error: null,
    };
  },
  useLakeSessions: (where: Record<string, string>) => {
    asked.sessions.push(where);
    return {
      data: { values: lake.sessions[JSON.stringify(where)] ?? [] },
      isPending: false,
      isError: false,
      error: null,
    };
  },
  useRuns: (filters: Record<string, unknown>) => {
    asked.runs.push(filters);
    return { data: { items: RUNS, total: RUNS.length }, isPending: false, isError: false, isSuccess: true };
  },
}));

import { SessionsDialog } from "@/components/screens/workbooks/sessions-dialog";

function open(selected: string[] = [], multiDefault = false) {
  const onChange = vi.fn();
  render(
    <SessionsDialog
      selected={selected}
      onChange={onChange}
      onClose={() => {}}
      multiDefault={multiDefault}
    />,
  );
  return onChange;
}

const tree = () => screen.getByRole("navigation", { name: "Lake folders" });
const pane = () => screen.getByRole("region", { name: "Sessions" });

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  asked.levels.length = 0;
  asked.sessions.length = 0;
  asked.runs.length = 0;
});

describe("SessionsDialog", () => {
  it("opens on every session the lake holds, newest first, with the picked one ticked", () => {
    open(["r2"]);
    // The right pane names the folder the sessions come from: the whole lake.
    expect(within(pane()).getByText("All sessions")).toBeInTheDocument();
    expect(asked.sessions[0]).toEqual({});
    const rows = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("radio") !== null);
    expect(rows.map((li) => within(li).getByRole("radio").getAttribute("aria-label"))).toEqual([
      "Select r1",
      "Select r2",
      "Select r3",
    ]);
    expect(screen.getByLabelText("Select r2")).toBeChecked();
    expect(screen.getByLabelText("Select r1")).not.toBeChecked();
  });

  it("says which sessions the registry has never heard of", () => {
    open();
    const r3 = screen.getByLabelText("Select r3").closest("li");
    expect(within(r3 as HTMLElement).getByText("lake only")).toBeInTheDocument();
    const r1 = screen.getByLabelText("Select r1").closest("li");
    expect(within(r1 as HTMLElement).queryByText("lake only")).toBeNull();
  });

  it("shows the lake's folders, titled by what the Test Manager knows", () => {
    open();
    expect(within(tree()).getByText("AC3")).toBeInTheDocument();
    // A work order arrives as an id and is shown by its title — after the
    // folder is opened, because a level is read only when it is.
    expect(within(tree()).queryByText("Fleet — data pipeline acceptance")).toBeNull();
  });

  it("reads a level only when its folder is opened", async () => {
    open();
    const user = userEvent.setup();
    expect(asked.levels).toEqual([""]);
    await user.click(screen.getByLabelText("Expand AC3"));
    expect(asked.levels).toContain("platform=AC3");
    expect(asked.levels).not.toContain("platform=AC2");
    expect(within(tree()).getByText("Fleet — data pipeline acceptance")).toBeInTheDocument();
    expect(within(tree()).getByText("WO-1")).toBeInTheDocument();
    // The lake's placeholder folder reads as one word, not as `__None__`.
    expect(within(tree()).getByText("(none)")).toBeInTheDocument();
  });

  it("narrows the sessions to the folder picked, and the registry join with them", async () => {
    open();
    const user = userEvent.setup();
    await user.click(within(tree()).getByText("AC3"));
    expect(asked.sessions.at(-1)).toEqual({ platform: "AC3" });
    expect(screen.queryByLabelText("Select r2")).toBeNull();
    expect(screen.getByLabelText("Select r1")).toBeInTheDocument();

    await user.click(within(tree()).getByText("Fleet — data pipeline acceptance"));
    expect(asked.sessions.at(-1)).toEqual({ platform: "AC3", work_order: "WO-1" });
    // The run rows that decorate them are asked for by the same folder.
    expect(asked.runs.at(-1)).toMatchObject({ work_order: "WO-1", project: ["AC3"] });
    expect(within(pane()).getByText("Fleet — data pipeline acceptance")).toBeInTheDocument();
  });

  it("never filters the registry by the lake's placeholder", async () => {
    open();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Expand AC3"));
    await user.click(within(tree()).getByText("(none)"));
    expect(asked.runs.at(-1)).not.toHaveProperty("work_order");
    expect(asked.runs.at(-1)).toMatchObject({ project: ["AC3"] });
  });

  it("picks one at a time, replacing the session", async () => {
    const onChange = open(["r2"]);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Select r1"));
    expect(onChange).toHaveBeenLastCalledWith(["r1"]);
    expect(screen.queryByText("Select all")).not.toBeInTheDocument();
  });

  it("takes several once Multiple sessions is on", async () => {
    const onChange = open(["r2"], true);
    const user = userEvent.setup();
    expect(screen.getByText("Select all")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Select r1"));
    expect(onChange).toHaveBeenLastCalledWith(["r2", "r1"]);
  });

  it("keeps the first session when Multiple sessions goes off", async () => {
    const onChange = open(["r2", "r1"], true);
    const user = userEvent.setup();
    await user.click(screen.getByText("Multiple sessions"));
    expect(onChange).toHaveBeenLastCalledWith(["r2"]);
  });

  it("filters every loaded level, and keeps the branch that is open", async () => {
    open();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Expand AC3"));
    await user.type(screen.getByLabelText("Filter folders"), "fleet");
    // The work order matches by its title, one level down…
    expect(within(tree()).getByText("Fleet — data pipeline acceptance")).toBeInTheDocument();
    expect(within(tree()).queryByText("(none)")).toBeNull();
    // …and the folder it sits in stays, though its own name matches nothing.
    expect(within(tree()).getByText("AC3")).toBeInTheDocument();
    expect(within(tree()).queryByText("AC2")).toBeNull();
  });

  it("filters the sessions listed by what is typed", async () => {
    open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Filter sessions"), "r3");
    expect(screen.getByLabelText("Select r3")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select r1")).toBeNull();
  });
});
