import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Crumb, Crumbs } from "@/components/shared/crumbs";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

describe("Crumbs", () => {
  it("renders a breadcrumb navigation landmark", () => {
    render(
      <Crumbs>
        <Crumb type="run">RUN-1</Crumb>
      </Crumbs>
    );
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
  });

  it("renders separators between siblings but not before the first item", () => {
    render(
      <Crumbs>
        <Crumb type="run">RUN-1</Crumb>
        <Crumb type="file">FILE-1</Crumb>
        <Crumb type="signal" current>
          SIG-1
        </Crumb>
      </Crumbs>
    );
    const separators = screen.getAllByText("›");
    expect(separators).toHaveLength(2);
    for (const separator of separators) {
      expect(separator).toHaveAttribute("aria-hidden");
    }
  });
});

describe("Crumb", () => {
  it("renders a link with the href when navigable", () => {
    render(
      <Crumb type="run" href="/runs/RUN-1">
        RUN-1
      </Crumb>
    );
    const link = screen.getByRole("link", { name: /RUN-1/ });
    expect(link).toHaveAttribute("href", "/runs/RUN-1");
    expect(link).toHaveTextContent("run");
  });

  it("renders the type label uppercase-styled", () => {
    render(
      <Crumb type="work order" href="/work-orders/WO-1">
        WO-1
      </Crumb>
    );
    expect(screen.getByText("work order")).toHaveClass("uppercase");
  });

  it("renders the current crumb as a dark non-link with aria-current", () => {
    render(
      <Crumb type="run" href="/runs/RUN-1" current>
        RUN-1
      </Crumb>
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const chip = screen.getByText("RUN-1").closest("span");
    expect(chip).toHaveAttribute("aria-current", "page");
    expect(chip).toHaveClass("bg-ink", "text-bg");
  });

  it("renders a missing crumb as a dashed non-link even when href is given", () => {
    render(
      <Crumb type="work order" href="/work-orders/WO-9" missing>
        Not synced
      </Crumb>
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const chip = screen.getByText("Not synced").closest("span");
    expect(chip).toHaveClass("border-dashed", "text-ink-3");
    expect(chip).not.toHaveAttribute("aria-current");
  });
});
