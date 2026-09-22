/**
 * Results panel timing footer — the client-measured wall clock beside the
 * API's lake round-trip, with the residual labeled transfer (it is mostly
 * network + proxy hop, never app work). Without timing the footer stays the
 * plain DuckDB sentence, so the pre-existing panel suite is untouched.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultsPanel } from "@/components/screens/run-detail/explore-tab/results-panel";
import type { ExploreQueryResult } from "@/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const result: ExploreQueryResult = {
  columns: [{ name: "signal" }],
  rows: [["HV_Batt_Cell_Temp_Max"]],
  row_count: 1,
  truncated: false,
  elapsed_ms: 198,
};

describe("ResultsPanel timing footer", () => {
  it("shows end-to-end, lake and transfer when timing is provided", () => {
    render(
      <ResultsPanel
        runId="TAS-88214"
        result={result}
        error={null}
        isPending={false}
        onRetry={() => undefined}
        timing={{ totalMs: 243, lakeMs: 198 }}
      />,
    );
    expect(screen.getByText(/Query completed/)).toBeInTheDocument();
    expect(screen.getByText(/243 ms end-to-end/)).toBeInTheDocument();
    expect(screen.getByText(/198 ms in lake · 45 ms transfer/)).toBeInTheDocument();
  });

  it("clamps a negative transfer residual to zero", () => {
    render(
      <ResultsPanel
        runId="TAS-88214"
        result={result}
        error={null}
        isPending={false}
        onRetry={() => undefined}
        timing={{ totalMs: 150, lakeMs: 198 }}
      />,
    );
    expect(screen.getByText(/0 ms transfer/)).toBeInTheDocument();
  });

  it("keeps the plain footer without timing", () => {
    render(
      <ResultsPanel
        runId="TAS-88214"
        result={result}
        error={null}
        isPending={false}
        onRetry={() => undefined}
      />,
    );
    expect(screen.queryByText(/Query completed/)).not.toBeInTheDocument();
    expect(screen.getByText(/DuckDB runs the query inside the lake/)).toBeInTheDocument();
  });
});
