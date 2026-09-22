/**
 * The sidebar reaches every screen the front end ships.
 *
 * `/definitions` and `/definitions/{id}` both shipped, and the only way in was
 * the Home "orphaned definitions" line. A person who never opens Home could
 * not reach the screen at all (UC-005).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

let summary: { counts: Record<string, number> } | undefined = undefined;

vi.mock("@/lib/hooks", () => ({
  useHomeSummary: () => ({ data: summary }),
  usePlanningSyncStatus: () => ({ data: undefined }),
}));

import { Sidebar } from "@/components/shell/sidebar";

describe("the sidebar links to the test definitions screen", () => {
  beforeEach(() => {
    summary = undefined;
  });

  it("names the entry and points it at /definitions", () => {
    pathname = "/";
    render(<Sidebar />);

    const link = screen.getByRole("link", { name: "Test definitions" });
    expect(link).toHaveAttribute("href", "/definitions");
  });

  it("marks the entry as the current page on the definition detail screen", () => {
    pathname = "/definitions/TD-4471";
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: "Test definitions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("leaves the entry unmarked on another screen", () => {
    pathname = "/files";
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: "Test definitions" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});

describe("the sidebar counts the test definitions", () => {
  beforeEach(() => {
    pathname = "/";
  });

  it("shows the count the home summary serves", () => {
    summary = { counts: { test_definitions: 1234 } };
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: "Test definitions 1,234" })).toBeInTheDocument();
  });

  it("reads a missing count as zero, never as NaN", () => {
    // An API built before this count sends no `test_definitions` field.
    summary = { counts: {} };
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: "Test definitions 0" })).toBeInTheDocument();
  });
});
