import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickViewSegment, type QuickView } from "@/components/shared/quick-view-segment";

const views: readonly QuickView[] = [
  { id: "all", label: "All", count: 128 },
  { id: "attention", label: "Needs attention", count: 3 },
  { id: "invalid", label: "Invalid" }, // count intentionally absent
];

describe("QuickViewSegment", () => {
  it("marks the active view with aria-pressed=true and others false", () => {
    render(
      <QuickViewSegment
        views={views}
        activeId="attention"
        onSelect={vi.fn()}
        aria-label="Run quick views"
      />
    );
    expect(screen.getByRole("button", { name: /Needs attention/, pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^All/, pressed: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Invalid/, pressed: false })).toBeInTheDocument();
  });

  it("renders no count badge when count is absent", () => {
    render(
      <QuickViewSegment views={views} activeId="all" onSelect={vi.fn()} aria-label="Run quick views" />
    );
    const invalidBtn = screen.getByRole("button", { name: /^Invalid/ });
    // No numeric text — accessible name is exactly "Invalid".
    expect(invalidBtn.textContent).toBe("Invalid");
    // Other buttons carry their count in the text content.
    const attentionBtn = screen.getByRole("button", { name: /Needs attention/ });
    expect(attentionBtn.textContent).toContain("3");
  });

  it("renders no active button when activeId is null", () => {
    render(
      <QuickViewSegment views={views} activeId={null} onSelect={vi.fn()} aria-label="Run quick views" />
    );
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("fires onSelect with the clicked view id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <QuickViewSegment
        views={views}
        activeId="all"
        onSelect={onSelect}
        aria-label="Run quick views"
      />
    );
    await user.click(screen.getByRole("button", { name: /^Invalid/ }));
    expect(onSelect).toHaveBeenCalledWith("invalid");
  });

  it("groups the buttons under the aria-label", () => {
    render(
      <QuickViewSegment views={views} activeId="all" onSelect={vi.fn()} aria-label="Run quick views" />
    );
    expect(screen.getByRole("group", { name: "Run quick views" })).toBeInTheDocument();
  });
});
