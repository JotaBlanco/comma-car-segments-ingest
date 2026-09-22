/**
 * The sidebar's Lakehouse item leads to `/lakehouse`, which frames the
 * Portal's own Lakehouse page.
 *
 * Validates architecture.md "What changed": the row stopped opening a tab and
 * became an ordinary `<Link>` — same active state, same rail tooltip as every
 * registry row. Two rules hold here:
 *
 *   1. the row is a Link to `/lakehouse`, with no `target="_blank"`;
 *   2. no URL means no row — an empty answer and a failed call both hide it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const { usePathname } = vi.hoisted(() => ({ usePathname: vi.fn(() => "/runs") }));
vi.mock("next/navigation", () => ({
  usePathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/hooks", () => ({
  useHomeSummary: () => ({ data: undefined }),
  usePlanningSyncStatus: () => ({ data: undefined }),
}));

const { listQuixLabs, getLakehouseUrl } = vi.hoisted(() => ({
  listQuixLabs: vi.fn(),
  getLakehouseUrl: vi.fn(),
}));
vi.mock("@/lib/api/integrations", () => ({ listQuixLabs, getLakehouseUrl }));

import { Sidebar } from "@/components/shell/sidebar";
import { setQuixLabPortalUrl, setQuixLabUrl } from "@/lib/quixlab";

const QUIXLAB = "https://quixlab-abc123.dev.quix.io";
const LAKEHOUSE = "https://portal.dev.quix.io/lakehouse?workspace=quixdev-testmanagerdemo-dev";

beforeEach(() => {
  usePathname.mockReturnValue("/runs");
  listQuixLabs.mockReset();
  listQuixLabs.mockResolvedValue([]);
  getLakehouseUrl.mockReset();
  getLakehouseUrl.mockResolvedValue("");
  // The Analysis section exists when a QuixLab is configured.
  setQuixLabUrl(QUIXLAB);
});

afterEach(() => {
  setQuixLabUrl(null);
  setQuixLabPortalUrl(null);
});

describe("the sidebar Lakehouse item", () => {
  it("links to /lakehouse, not the Portal URL the API answered", async () => {
    getLakehouseUrl.mockResolvedValue(LAKEHOUSE);

    const view = render(<Sidebar />);
    const link = await view.findByRole("link", { name: "Lakehouse" });

    expect(link.getAttribute("href")).toBe("/lakehouse");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("shows no item when the API answers no URL", async () => {
    getLakehouseUrl.mockResolvedValue("");

    const view = render(<Sidebar />);
    await waitFor(() => expect(getLakehouseUrl).toHaveBeenCalled());

    expect(view.queryByRole("link", { name: "Lakehouse" })).toBeNull();
  });

  it("shows no item when the call fails", async () => {
    getLakehouseUrl.mockRejectedValue(new Error("the API did not answer"));

    const view = render(<Sidebar />);
    await waitFor(() => expect(getLakehouseUrl).toHaveBeenCalled());

    expect(view.queryByRole("link", { name: "Lakehouse" })).toBeNull();
  });

  it("carries the active state on /lakehouse, the same rule every registry row follows", async () => {
    usePathname.mockReturnValue("/lakehouse");
    getLakehouseUrl.mockResolvedValue(LAKEHOUSE);

    const view = render(<Sidebar />);
    const link = await view.findByRole("link", { name: "Lakehouse" });

    expect(link).toHaveAttribute("aria-current", "page");
  });
});
