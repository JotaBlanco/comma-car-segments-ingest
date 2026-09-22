import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge, ToneBadge, type BadgeStatus } from "@/components/shared/status-badge";

const cases: Array<{ status: BadgeStatus; label: string; bg: string; text: string; dot: string }> = [
  { status: "complete", label: "Linked", bg: "bg-green-bg", text: "text-green", dot: "bg-green-dot" },
  {
    status: "awaiting_work_order",
    label: "Awaiting work order",
    bg: "bg-amber-bg",
    text: "text-amber",
    dot: "bg-amber-dot",
  },
  { status: "invalid", label: "Invalid", bg: "bg-red-bg", text: "text-red", dot: "bg-red-dot" },
  { status: "registered", label: "Registered", bg: "bg-green-bg", text: "text-green", dot: "bg-green-dot" },
  { status: "quarantined", label: "Quarantined", bg: "bg-red-bg", text: "text-red", dot: "bg-red-dot" },
];

describe("StatusBadge", () => {
  for (const { status, label, bg, text, dot } of cases) {
    it(`renders '${status}' as "${label}" with the correct tone`, () => {
      const { container } = render(<StatusBadge status={status} />);
      const badge = screen.getByText(label).closest("span");
      expect(badge).toHaveClass(bg, text);
      // StatusBadge always renders the tone dot
      const dotEl = container.querySelector(".rounded-full");
      expect(dotEl).not.toBeNull();
      expect(dotEl).toHaveClass(dot);
    });
  }

  it("supports a custom label override while keeping the status tone", () => {
    render(<StatusBadge status="invalid" label="Rejected by engineer" />);
    const badge = screen.getByText("Rejected by engineer").closest("span");
    expect(badge).toHaveClass("bg-red-bg", "text-red");
    expect(screen.queryByText("Invalid")).not.toBeInTheDocument();
  });
});

describe("ToneBadge", () => {
  it("renders children with the tone class and no dot by default", () => {
    const { container } = render(<ToneBadge tone="neutral">Draft</ToneBadge>);
    const badge = screen.getByText("Draft");
    expect(badge).toHaveClass("bg-muted", "text-ink-2");
    expect(container.querySelector(".rounded-full")).toBeNull();
  });

  it("renders a tone-matched dot when dot is set", () => {
    const { container } = render(
      <ToneBadge tone="amber" dot>
        Pending
      </ToneBadge>
    );
    const dotEl = container.querySelector(".rounded-full");
    expect(dotEl).not.toBeNull();
    expect(dotEl).toHaveClass("bg-amber-dot");
  });
});
