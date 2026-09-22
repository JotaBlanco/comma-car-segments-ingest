/**
 * The Issues page lists every finding in the lake across runs, filters it through the URL
 * state every list screen shares, and links each row to the issue's own page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DataSnippet } from "@/types";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/issues",
  useSearchParams: () => nav.params,
}));

const { useAllSnippets } = vi.hoisted(() => ({ useAllSnippets: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useAllSnippets }));

import { IssuesScreen } from "@/components/screens/issues/issues-screen";
import { setQuixLabUrl } from "@/lib/quixlab";
import { setFtsConfig } from "@/lib/fts";

const RUN_A = "sn002_20250125T150942051Z";
const RUN_B = "sn002_20260723T131303942Z";

function snip(id: number, run: string, tags: string[], name: string): DataSnippet {
  return {
    id,
    name,
    sql: `SELECT * FROM t WHERE run_id = '${run}'`,
    partitions: [`platform=sn002/run_id=${run}/protocol=a429`],
    markdown: `# ${name}\n\nA finding.\n**Time:** 1737821514758 - 1737821514900\n`,
    tags,
    updated_at: `2026-09-1${id}T10:00:00Z`,
  };
}

const ROWS = [
  snip(1, RUN_A, ["quixlab-store", "ai_3_store", "ai_3", "anomaly", "open"], "INS1 · alt · one"),
  snip(2, RUN_B, ["quixlab-store", "ai_3_store", "ai_3", "gap", "resolved"], "INS2 · speed · two"),
  snip(3, RUN_B, ["quixlab-store", "ai_2_store", "ai_2", "outlier", "closed"], "INS3 · alt · three"),
];

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.params = new URLSearchParams();
  useAllSnippets.mockReturnValue({
    data: { table: "t", run: "", snippets: ROWS },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  });
  setQuixLabUrl(null);
  setFtsConfig(null, null);
});

afterEach(() => vi.clearAllMocks());

describe("IssuesScreen", () => {
  it("lists every finding with its state and run, and counts the quick views", () => {
    render(<IssuesScreen />);
    const table = screen.getByRole("table", { name: "Issues" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("Resolved")).toBeInTheDocument();
    expect(within(table).getAllByRole("link", { name: RUN_B })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "INS1 · alt · one" })).toHaveAttribute(
      "href",
      "/issues/1",
    );
    expect(screen.getByText("Open", { selector: "button *, button" })).toBeInTheDocument();
  });

  it("applies the URL's filters: a quick view, a run, and the kind panel", async () => {
    nav.params = new URLSearchParams("state=resolved&run=" + RUN_B);
    render(<IssuesScreen />);
    const table = screen.getByRole("table", { name: "Issues" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("INS2 · speed · two")).toBeInTheDocument();
    expect(screen.getByText(RUN_B, { selector: "[class*='pill'] *, span" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: /Issue/ }));
    expect(nav.push).toHaveBeenCalled();
  });

  it("opens the issue’s own page when a row is clicked", async () => {
    render(<IssuesScreen />);
    const user = userEvent.setup();
    // The name is a real link that stops the row click; the note cell is the row.
    const row = screen.getByText("INS3 · alt · three").closest("tr")!;
    await user.click(within(row).getByText("A finding."));
    expect(nav.push).toHaveBeenLastCalledWith("/issues/3");
  });
});
