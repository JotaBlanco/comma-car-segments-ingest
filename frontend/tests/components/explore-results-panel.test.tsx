/**
 * ResultsPanel — rendering rules (plan §4).
 *
 *  - Empty/null cells render "—" (the NO_STAT convention) — never fake zeros.
 *  - Counts/timings via en-GB formatting.
 *  - 503 lake_unavailable renders the ErrorState-based panel (modelled on the
 *    download-button's 503 branch) with a retry.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResultsPanel } from "@/components/screens/run-detail/explore-tab/results-panel";
import { ApiError } from "@/lib/api/client";
import type { ExploreQueryResult } from "@/types";

function result(overrides: Partial<ExploreQueryResult> = {}): ExploreQueryResult {
  return {
    columns: [{ name: "signal" }, { name: "ts" }, { name: "value" }],
    rows: [
      ["brake_temp_FL", "2026-08-14T09:41:07Z", "148.20"],
      ["brake_temp_FR", "2026-08-14T09:41:07Z", ""],
    ],
    row_count: 2,
    truncated: false,
    elapsed_ms: 420,
    ...overrides,
  };
}

describe("ResultsPanel", () => {
  it("renders — for empty cells, never a zero", () => {
    render(
      <ResultsPanel
        runId="TAS-88214"
        result={result()}
        error={null}
        isPending={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    // The empty cell must not be coerced into a numeric zero.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
    expect(screen.getByText("brake_temp_FL")).toBeInTheDocument();
  });

  it("shows the en-GB row count and lakeside timing", () => {
    render(
      <ResultsPanel
        runId="TAS-88214"
        result={result({ row_count: 12_480, elapsed_ms: 420 })}
        error={null}
        isPending={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/12,480 rows · 0\.42 s lakeside/)).toBeInTheDocument();
  });

  it("marks a truncated result", () => {
    render(
      <ResultsPanel
        runId="TAS-88214"
        result={result({ truncated: true })}
        error={null}
        isPending={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/\(truncated\)/)).toBeInTheDocument();
  });

  it("renders the lake_unavailable panel with a retry on a 503", () => {
    const onRetry = vi.fn();
    render(
      <ResultsPanel
        runId="TAS-88214"
        result={undefined}
        error={new ApiError(503, "QuixLake is not configured", "lake_unavailable")}
        isPending={false}
        onRetry={onRetry}
      />,
    );
    expect(
      screen.getByText("Lake unreachable — Explore queries run in the deployed environment."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("surfaces the detail of other API errors", () => {
    render(
      <ResultsPanel
        runId="TAS-88214"
        result={undefined}
        error={new ApiError(404, "Run TAS-0 not found", "run_not_found")}
        isPending={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Run TAS-0 not found")).toBeInTheDocument();
  });

  it("prompts to run a query before any result exists", () => {
    render(
      <ResultsPanel
        runId="TAS-88214"
        result={undefined}
        error={null}
        isPending={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("No query run yet")).toBeInTheDocument();
  });
});
