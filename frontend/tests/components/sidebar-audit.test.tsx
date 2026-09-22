/**
 * The sidebar reaches the Audit screen (FR-DM-055, NFR-DM-049).
 *
 * The screen answers `GET /journal`, the one read that crosses every entity.
 * No other screen links to it, so without this entry nobody reaches it.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

vi.mock("@/lib/hooks", () => ({
  useHomeSummary: () => ({ data: undefined }),
  usePlanningSyncStatus: () => ({ data: undefined }),
}));

import { Sidebar } from "@/components/shell/sidebar";

describe("the sidebar links to the audit screen", () => {
  it("names the entry and points it at /audit", () => {
    pathname = "/";
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: "Audit" })).toHaveAttribute("href", "/audit");
  });

  it("marks the entry as the current page on the audit screen", () => {
    pathname = "/audit";
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: "Audit" })).toHaveAttribute("aria-current", "page");
  });

  it("leaves the entry unmarked on another screen", () => {
    pathname = "/files";
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: "Audit" })).not.toHaveAttribute("aria-current");
  });
});
