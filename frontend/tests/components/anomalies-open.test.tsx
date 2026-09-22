/**
 * The Anomalies tab reads QuixLab's tags and opens each finding where it lives.
 *
 * QuixLab tags every snippet it writes with the store, the analysis, the kind and the
 * state, and the tab shows the kind and the state as badges, filters by state, and opens
 * a finding in QuixLab on the analysis cell and in the Flight Test Station on the run,
 * the signal and the period. Neither link carries a token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DataSnippet } from "@/types";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/runs/r",
  useSearchParams: () => new URLSearchParams(),
}));

const { useRunSnippets, useSnippetData } = vi.hoisted(() => ({
  useRunSnippets: vi.fn(),
  useSnippetData: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({ useRunSnippets, useSnippetData }));

import { AnomaliesTab } from "@/components/screens/run-detail/anomalies-tab";
import { setFtsConfig } from "@/lib/fts";
import { setQuixLabPortalUrl, setQuixLabUrl } from "@/lib/quixlab";

const RUN = "sn002_20260723T131303942Z";
const QUIXLAB = "https://quixlab.example";
const FTS = "https://fts.example";

function snip(id: number, tags: string[], over: Partial<DataSnippet> = {}): DataSnippet {
  return {
    id,
    name: `INS1 · ground_speed · ${id}`,
    sql: "SELECT 1",
    partitions: [`platform=sn002/run_id=${RUN}/protocol=a429`],
    markdown: `# INS1 · ground_speed\n\nA finding.\n**Partitions:** bus=INS1 · signal=ground_speed\n**Time:** 1737821514758 - 1737821514900\n`,
    tags,
    updated_at: "2026-09-15T16:00:37Z",
    ...over,
  };
}

const SNIPPETS = [
  snip(1, ["quixlab-store", "ai_3_store", "ai_3", "anomaly", "open"]),
  snip(2, ["quixlab-store", "ai_3_store", "ai_3", "gap", "resolved"]),
];

let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useRunSnippets.mockReturnValue({ data: { snippets: SNIPPETS }, isPending: false, isError: false });
  useSnippetData.mockReturnValue({ data: undefined, isPending: true, isError: false });
  open = vi.spyOn(window, "open").mockImplementation(() => null);
  setQuixLabUrl(QUIXLAB);
  setQuixLabPortalUrl(null);
  setFtsConfig(FTS, FTS);
});

afterEach(() => {
  open.mockRestore();
  setQuixLabUrl(null);
  setFtsConfig(null, null);
});

describe("AnomaliesTab", () => {
  it("shows the kind and the state QuixLab tagged, and filters by state", async () => {
    const user = userEvent.setup();
    render(<AnomaliesTab runId={RUN} />);
    const table = screen.getByRole("table", { name: "Data snippets of this run" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("gap")).toBeInTheDocument();
    expect(within(table).getByText("Resolved")).toBeInTheDocument();
    expect(within(table).getAllByText("ai_3_store · ai_3")).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText("Filter snippets by state"), "open");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Open")).toBeInTheDocument();
    expect(within(table).queryByText("Resolved")).not.toBeInTheDocument();
  });

  it("opens a finding in QuixLab on its analysis cell and in the station on its period", async () => {
    const user = userEvent.setup();
    render(<AnomaliesTab runId={RUN} />);
    const row = screen.getByRole("link", { name: "INS1 · ground_speed · 2" }).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /in QuixLab/ }));
    expect(open).toHaveBeenLastCalledWith(
      `${QUIXLAB}?open=ai_3&kind=notebook&run=${RUN}`,
      "_blank",
      "noopener,noreferrer",
    );
    await user.click(within(row).getByRole("button", { name: /Flight Test Station/ }));
    const [ftsUrl] = open.mock.calls[open.mock.calls.length - 1] as [string];
    expect(ftsUrl.startsWith(`${FTS}?`)).toBe(true);
    const q = new URL(ftsUrl).searchParams;
    expect(q.get("run")).toBe(RUN);
    expect(q.get("signal")).toBe("ground_speed");
    expect(q.get("t")).toBe("1737821514758");
    expect(q.get("sel")).toBe("1737821514758,1737821514900");
    for (const [url] of open.mock.calls) expect(String(url)).not.toMatch(/token/i);
  });

  it("opens the issue's own page, telling it which run's tab sent it", async () => {
    const user = userEvent.setup();
    render(<AnomaliesTab runId={RUN} />);
    const name = screen.getByRole("link", { name: "INS1 · ground_speed · 2" });
    expect(name).toHaveAttribute("href", `/issues/2?from=${RUN}`);
    await user.click(within(name.closest("tr")!).getByText("A finding."));
    expect(push).toHaveBeenLastCalledWith(`/issues/2?from=${RUN}`);
  });

  it("lists the workbooks and opens the finding in one", async () => {
    const { createWorkbook, resetWorkbooksForTests } = await import("@/lib/workbooks");
    window.localStorage.clear();
    resetWorkbooksForTests();
    const w = createWorkbook("Approach")!;
    const user = userEvent.setup();
    render(<AnomaliesTab runId={RUN} />);
    const row = screen.getByRole("link", { name: "INS1 · ground_speed · 2" }).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /in a workbook/ }));
    expect(await screen.findByRole("menuitem", { name: "Approach" })).toBeInTheDocument();
    // The Explorer is among the choices, on the issue's signal and period.
    expect(screen.getByRole("menuitem", { name: "Explorer" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Approach" }));
    expect(push).toHaveBeenLastCalledWith(
      `/workbooks/${w.id}?run=${RUN}&signal=ground_speed&t=1737821514758&sel=1737821514758%2C1737821514900&issue=2`,
    );
  });

  it("offers no destination it cannot reach, but always a workbook", () => {
    setQuixLabUrl(null);
    setFtsConfig(null, null);
    render(<AnomaliesTab runId={RUN} />);
    expect(screen.queryByRole("button", { name: /QuixLab/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Flight Test Station/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /in a workbook/ }).length).toBeGreaterThan(0);
  });
});
