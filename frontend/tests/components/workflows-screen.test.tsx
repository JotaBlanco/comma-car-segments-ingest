/**
 * The Workflows page lists every QuixLab notebook of every run, with the run's own
 * controls: Open goes to the notebook inside its run, Start and Stop act on this viewer's
 * lab, Delete asks twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Notebook } from "@/lib/api/run-quixlab";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/workflows",
  useSearchParams: () => nav.params,
}));

const { useAllNotebooks } = vi.hoisted(() => ({ useAllNotebooks: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useAllNotebooks }));

const api = vi.hoisted(() => ({
  openNotebook: vi.fn(),
  stopNotebook: vi.fn(),
  deleteNotebook: vi.fn(),
}));
vi.mock("@/lib/api/run-quixlab", () => ({
  ...api,
  running: (lab: { status: string }) => lab.status.trim().toLowerCase() === "running",
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { WorkflowsScreen } from "@/components/screens/workflows/workflows-screen";

const RUN_A = "sn059_20170302T091407312Z";
const RUN_B = "sn071_20170116T074211554Z";

function notebook(id: string, run: string, name: string, status: string | null): Notebook {
  return {
    notebook_id: id,
    run_id: run,
    name,
    created_by: "Ana",
    created_at: `2026-09-2${id.slice(-1)}T10:00:00Z`,
    saved_at: null,
    lab:
      status === null
        ? null
        : {
            id: `dep-${id}`,
            name: `tm-lab-${id}`,
            status,
            url: `https://${id}.dev.quix.io`,
            notebook: `blob://quixlab-runs/${run}/${id}/analysis.py`,
            created: false,
          },
  };
}

const ROWS = [
  notebook("nb-1", RUN_A, "Wing deflection", "Running"),
  notebook("nb-2", RUN_A, "Anomaly hunt", "Stopped"),
  notebook("nb-3", RUN_B, "Rig cycles", null),
];

function renderScreen() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <WorkflowsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.params = new URLSearchParams();
  useAllNotebooks.mockReturnValue({
    data: ROWS,
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  });
  api.openNotebook.mockResolvedValue(ROWS[1]);
  api.stopNotebook.mockResolvedValue(ROWS[0]);
  api.deleteNotebook.mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe("WorkflowsScreen", () => {
  it("lists every notebook of every run with its lab state, and counts the quick views", () => {
    renderScreen();
    const table = screen.getByRole("table", { name: "Workflows" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getAllByRole("link", { name: RUN_A })).toHaveLength(2);
    expect(within(table).getByText("Running")).toBeInTheDocument();
    expect(within(table).getByText("Stopped")).toBeInTheDocument();
    expect(within(table).getByText("Not started")).toBeInTheDocument();
    // Open is a link into the run page, which starts and embeds the notebook there.
    expect(screen.getByRole("link", { name: "Wing deflection" })).toHaveAttribute(
      "href",
      `/runs/${RUN_A}?tab=notebooks&notebook=nb-1`,
    );
    // A running lab offers Stop; a stopped or absent one offers Start.
    expect(screen.getByRole("button", { name: "Stop Wing deflection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Anomaly hunt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Rig cycles" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Rig cycles" })).not.toBeInTheDocument();
  });

  it("Start and Stop act on the notebook's own run and lab", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Start Rig cycles" }));
    await waitFor(() => expect(api.openNotebook).toHaveBeenCalledWith(RUN_B, "nb-3"));

    await user.click(screen.getByRole("button", { name: "Stop Wing deflection" }));
    await waitFor(() => expect(api.stopNotebook).toHaveBeenCalledWith(RUN_A, "nb-1"));
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  it("Delete arms on the first click and removes on the second", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Delete Anomaly hunt" }));
    expect(api.deleteNotebook).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm deleting Anomaly hunt" }));
    await waitFor(() => expect(api.deleteNotebook).toHaveBeenCalledWith(RUN_A, "nb-2"));
  });

  it("Open goes to the notebook inside its run", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Open Rig cycles" }));
    expect(nav.push).toHaveBeenCalledWith(`/runs/${RUN_B}?tab=notebooks&notebook=nb-3`);
  });

  it("applies the URL's quick view", () => {
    nav.params = new URLSearchParams("state=running&state=starting");
    renderScreen();
    const table = screen.getByRole("table", { name: "Workflows" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });
});
