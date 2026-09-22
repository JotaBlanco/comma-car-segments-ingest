import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { HomeSummary } from "@/types";

/* TR-011. The Home card states where the registry's metadata came from.

   It counts tagged FIELDS, not rows, and it keeps every source the API sends
   — including the ones at zero, so the card never reflows between two loads
   and a reader cannot confuse "nobody wrote this" with "the API forgot it". */

const { summary } = vi.hoisted(() => ({
  summary: { value: undefined as HomeSummary | undefined },
}));

vi.mock("@/lib/hooks", () => ({
  usePageTitle: () => undefined,
  useHomeSummary: () => ({
    data: summary.value,
    isPending: summary.value === undefined,
    isError: false,
    isSuccess: summary.value !== undefined,
    refetch: vi.fn(),
  }),
}));

import { SourceBreakdownPanel } from "@/components/screens/home/source-breakdown-panel";

const NOOP = () => undefined;

function panel() {
  return within(screen.getByText("Metadata by source").closest("div")!.parentElement!);
}

describe("the Home source breakdown", () => {
  it("prints one row per source, in the order the API sends", () => {
    render(
      <SourceBreakdownPanel
        breakdown={[
          { source: "embedded", field_count: 1024 },
          { source: "manual", field_count: 37 },
          { source: "api:planning", field_count: 126 },
        ]}
        isPending={false}
        isError={false}
        onRetry={NOOP}
      />
    );

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/runs?source=embedded",
      "/runs?source=manual",
      "/runs?source=api%3Aplanning",
    ]);
  });

  it("keeps a source that wrote nothing, and states its zero", () => {
    render(
      <SourceBreakdownPanel
        breakdown={[
          { source: "embedded", field_count: 4 },
          { source: "api:post-processing", field_count: 0 },
        ]}
        isPending={false}
        isError={false}
        onRetry={NOOP}
      />
    );

    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(panel().getByText("0")).toBeInTheDocument();
  });

  it("sums the fields, not the rows", () => {
    render(
      <SourceBreakdownPanel
        breakdown={[
          { source: "embedded", field_count: 1024 },
          { source: "manual", field_count: 37 },
        ]}
        isPending={false}
        isError={false}
        onRetry={NOOP}
      />
    );

    expect(panel().getByText("1,061 fields")).toBeInTheDocument();
  });

  it("draws nothing but the head when an older API sends no breakdown", () => {
    // `source_breakdown` is optional. An API built before 24 Aug 2026 omits
    // it, and the card must not crash and must not print "NaN".
    render(
      <SourceBreakdownPanel
        breakdown={undefined}
        isPending={false}
        isError={false}
        onRetry={NOOP}
      />
    );

    expect(screen.getByText("Metadata by source")).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("offers a retry when the summary fails", () => {
    const retry = vi.fn();
    render(
      <SourceBreakdownPanel
        breakdown={undefined}
        isPending={false}
        isError={true}
        onRetry={retry}
      />
    );

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
