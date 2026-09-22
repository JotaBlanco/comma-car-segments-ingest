/**
 * The sidebar's Lakehouse item opens the Portal's own Lakehouse page.
 *
 * The link is `{portalWeb}/lakehouse?workspace={workspaceId}`. That page
 * resolves the Lakehouse itself and runs its own token handshake, so the link
 * carries a workspace id and nothing else. Three rules hold here:
 *
 *   1. the item shows the exact URL the API answered, in a new tab, with
 *      `rel="noreferrer"`;
 *   2. no URL means no item — an empty answer and a failed call both hide it;
 *   3. the URL carries no credential of any kind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/runs",
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
  it("links the Portal Lakehouse page, in a new tab, with no referrer", async () => {
    getLakehouseUrl.mockResolvedValue(LAKEHOUSE);

    const view = render(<Sidebar />);
    const link = await view.findByRole("link", { name: /Lakehouse/ });

    expect(link.getAttribute("href")).toBe(LAKEHOUSE);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("shows no item when the API answers no URL", async () => {
    getLakehouseUrl.mockResolvedValue("");

    const view = render(<Sidebar />);
    await waitFor(() => expect(getLakehouseUrl).toHaveBeenCalled());

    expect(view.queryByRole("link", { name: /Lakehouse/ })).toBeNull();
  });

  it("shows no item when the call fails", async () => {
    getLakehouseUrl.mockRejectedValue(new Error("the API did not answer"));

    const view = render(<Sidebar />);
    await waitFor(() => expect(getLakehouseUrl).toHaveBeenCalled());

    expect(view.queryByRole("link", { name: /Lakehouse/ })).toBeNull();
  });

  it("puts no credential in the link", async () => {
    getLakehouseUrl.mockResolvedValue(LAKEHOUSE);

    const view = render(<Sidebar />);
    const link = await view.findByRole("link", { name: /Lakehouse/ });

    const href = (link.getAttribute("href") ?? "").toLowerCase();
    for (const secret of ["token", "secret", "password", "bearer", "@"]) {
      expect(href).not.toContain(secret);
    }
  });
});
