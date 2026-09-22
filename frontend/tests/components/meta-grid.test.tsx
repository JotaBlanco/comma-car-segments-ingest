import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetaCell, MetaGrid } from "@/components/shared/meta-grid";

describe("MetaGrid", () => {
  it("renders children verbatim inside the grid", () => {
    render(
      <MetaGrid>
        <MetaCell label="Rig">RIG-04</MetaCell>
        <MetaCell label="Operator">j.smith</MetaCell>
      </MetaGrid>
    );
    expect(screen.getByText("RIG-04")).toBeInTheDocument();
    expect(screen.getByText("j.smith")).toBeInTheDocument();
  });
});

describe("MetaCell", () => {
  it("renders the label styled uppercase", () => {
    render(<MetaCell label="Work order">WO-1234</MetaCell>);
    const labelEl = screen.getByText("Work order");
    expect(labelEl.closest("div")).toHaveClass("uppercase");
  });

  it("renders a SourceBadge when source is provided", () => {
    render(
      <MetaCell label="Definition" source="api:planning">
        DEF-9
      </MetaCell>
    );
    expect(screen.getByText("api:planning")).toBeInTheDocument();
  });

  it("omits the SourceBadge when source is not provided", () => {
    const { container } = render(<MetaCell label="Definition">DEF-9</MetaCell>);
    expect(container.querySelector(".font-mono")).toBeNull();
  });

  it("applies muted styling to the value when muted", () => {
    render(
      <MetaCell label="Notes" muted>
        —
      </MetaCell>
    );
    expect(screen.getByText("—")).toHaveClass("text-ink-3");
  });

  it("does not apply muted styling by default", () => {
    render(<MetaCell label="Notes">Present</MetaCell>);
    expect(screen.getByText("Present")).not.toHaveClass("text-ink-3");
  });

  it("renders arbitrary children verbatim", () => {
    render(
      <MetaCell label="Status">
        <em data-nested>emphasised value</em>
      </MetaCell>
    );
    const nested = screen.getByText("emphasised value");
    expect(nested.tagName).toBe("EM");
  });
});
