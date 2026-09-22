/**
 * Workbooks: the list creates and opens one; the workbook page mounts the station on the
 * run the URL names, hands it the workbook's layout, and keeps every change it reports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/workbooks",
  useSearchParams: () => nav.params,
}));
/* The station is its own app with its own boot; this test checks the wiring only. */
const stationMock = vi.hoisted(() => ({
  handle: null as null | { name: string; layout: readonly unknown[]; onLayout(l: unknown): void },
}));
vi.mock("@/station/Station", () => ({
  default: ({
    workbook,
    leading,
  }: {
    workbook?: typeof stationMock.handle;
    leading?: React.ReactNode;
  }) => {
    stationMock.handle = workbook ?? null;
    return (
      <div data-testid="station" data-name={workbook?.name} data-layout={workbook?.layout.length}>
        {leading}
      </div>
    );
  },
}));
vi.mock("@/lib/hooks", () => ({
  useWorkOrders: () => ({ data: { items: [] }, isPending: false, isError: false }),
  useWorkOrder: () => ({ data: undefined, isPending: false, isError: false }),
  useTestDefinitions: () => ({ data: { items: [] }, isPending: false, isError: false }),
  useRuns: () => ({ data: undefined, isPending: false, isError: false, isSuccess: false }),
  useAllSnippets: () => ({ data: undefined, isPending: false, isError: false, isSuccess: true }),
  /* The sessions dialog reads its folders and its sessions from the lake. */
  useLakeLevel: () => ({ data: { partitions: [] }, isPending: false, isError: false, error: null }),
  useLakeSessions: () => ({ data: { values: [] }, isPending: false, isError: false, error: null }),
}));

import { WorkbooksScreen } from "@/components/screens/workbooks/workbooks-screen";
import { WorkbookScreen } from "@/components/screens/workbooks/workbook-screen";
import { setFtsConfig } from "@/lib/fts";
import { createWorkbook, listWorkbooks, resetWorkbooksForTests } from "@/lib/workbooks";

const FTS = "http://fts.localhost";

beforeEach(() => {
  // The workbook picker's list measures itself; jsdom has no observer.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
  window.localStorage.clear();
  resetWorkbooksForTests();
  nav.push.mockReset();
  nav.params = new URLSearchParams();
  setFtsConfig(FTS, FTS);
});

afterEach(() => {
  setFtsConfig(null, null);
});

describe("WorkbooksScreen", () => {
  it("creates a workbook and opens it", async () => {
    const user = userEvent.setup();
    render(<WorkbooksScreen />);
    expect(screen.getByText("No workbooks yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /New workbook/ }));
    await user.type(screen.getByLabelText("Workbook name"), "Approach");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const [w] = listWorkbooks();
    expect(w.name).toBe("Approach");
    expect(nav.push).toHaveBeenLastCalledWith(`/workbooks/${w.id}`);
  });
});

describe("WorkbookScreen", () => {
  it("mounts the station on the run with the workbook's layout and keeps what it reports", () => {
    const w = createWorkbook("Approach")!;
    nav.params = new URLSearchParams(`run=sn002_r1&signal=alt&sel=10,20`);
    render(<WorkbookScreen workbookId={w.id} />);
    const station = screen.getByTestId("station");
    expect(station).toHaveAttribute("data-name", "Approach");
    expect(station).toHaveAttribute("data-layout", "0");
    const layout = [{ id: "map", kind: "map", x: 0, y: 0, w: 6, h: 9 }];
    act(() => {
      stationMock.handle?.onLayout(layout);
    });
    expect(listWorkbooks()[0].layout).toEqual(layout);
    // The run a shortcut opened is now one of the workbook's sessions.
    expect(listWorkbooks()[0].sessions).toEqual(["sn002_r1"]);
    expect(screen.getByRole("button", { name: "Session" })).toHaveTextContent("sn002_r1");
  });

  it("switches workbook from the name, filtered by a search", async () => {
    const a = createWorkbook("Approach")!;
    const b = createWorkbook("Braking")!;
    nav.params = new URLSearchParams("run=sn002_r1");
    const user = userEvent.setup();
    render(<WorkbookScreen workbookId={a.id} />);
    await user.click(screen.getByRole("button", { name: /Workbook Approach/ }));
    await user.type(await screen.findByLabelText("Filter workbooks"), "brak");
    expect(screen.queryByRole("option", { name: /Approach/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Braking/ }));
    expect(nav.push).toHaveBeenLastCalledWith(`/workbooks/${b.id}?run=sn002_r1`);
  });

  it("offers the sessions dialog from the session dropdown", async () => {
    const w = createWorkbook("Blank")!;
    const user = userEvent.setup();
    render(<WorkbookScreen workbookId={w.id} />);
    const trigger = screen.getByRole("button", { name: "Session" });
    expect(trigger).toHaveTextContent("No session");
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: /Choose sessions/ }));
    expect(screen.getByRole("dialog", { name: "Sessions" })).toBeInTheDocument();
    // The tree is the lake's own folders. Its root lists every session, for a
    // workbook over the whole estate; a run no work order claims is not a
    // node of its own any more, it is the lake's `work_order=(none)` folder.
    await user.click(screen.getByRole("button", { name: "All sessions" }));
    expect(within(screen.getByRole("region", { name: "Sessions" })).getByText("All sessions")).toBeInTheDocument();
  });
});
