import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SourceBadge } from "@/components/shared/source-badge";

describe("SourceBadge", () => {
  it("renders 'embedded' with the gray variant", () => {
    render(<SourceBadge source="embedded" />);
    const badge = screen.getByText("embedded");
    expect(badge).toHaveClass("bg-muted", "text-ink-2");
  });

  it("renders 'manual' with the amber variant", () => {
    render(<SourceBadge source="manual" />);
    const badge = screen.getByText("manual");
    expect(badge).toHaveClass("bg-amber-bg", "text-amber");
  });

  it("renders 'api:planning' with the blue variant and full label", () => {
    render(<SourceBadge source="api:planning" />);
    const badge = screen.getByText("api:planning");
    expect(badge).toHaveClass("bg-accent-soft", "text-primary");
  });

  it("renders 'api:catalog' with the blue variant and full label", () => {
    render(<SourceBadge source="api:catalog" />);
    const badge = screen.getByText("api:catalog");
    expect(badge).toHaveClass("bg-accent-soft", "text-primary");
  });

  it("still renders unknown api:* strings with the api variant", () => {
    render(<SourceBadge source="api:some-future-system" />);
    const badge = screen.getByText("api:some-future-system");
    expect(badge).toHaveClass("bg-accent-soft", "text-primary");
  });

  it("carries the meaning of the tag in its accessible name", () => {
    render(<SourceBadge source="manual" />);
    expect(
      screen.getByRole("note", {
        name: "manual. A person typed this value into the Test Manager.",
      })
    ).toBeInTheDocument();
  });

  it("names the writing system, and spells the catalogue the American way", () => {
    render(<SourceBadge source="api:catalogue" />);
    expect(
      screen.getByRole("note", {
        name: "api:catalogue. The catalog system wrote this value over the API.",
      })
    ).toBeInTheDocument();
  });

  it("opens the explanation on keyboard focus, not on hover alone", async () => {
    const user = userEvent.setup();
    render(<SourceBadge source="embedded" />);
    expect(screen.getByText("embedded")).toHaveAttribute("tabindex", "0");
    await user.tab();
    // Re-read the node: mounting the tooltip replaces the span with an equal
    // one, and the badge keeps the focus across that swap.
    expect(screen.getByText("embedded")).toHaveFocus();
    expect(
      await screen.findByText("Ingestion wrote this value from the measurement file.")
    ).toBeInTheDocument();
  });

  it("merges a custom className", () => {
    render(<SourceBadge source="manual" className="custom-class" />);
    expect(screen.getByText("manual")).toHaveClass("custom-class");
  });
});
