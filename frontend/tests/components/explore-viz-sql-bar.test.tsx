/**
 * Viz panel "SQL — the query this chart runs" bar: collapsed by default,
 * expands to the generated statement, and hands it to a SQL tab. The query
 * mutation is left pending so no chart mounts in jsdom.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TestRun } from "@/types";

// jsdom has no ResizeObserver; the panel only needs it to exist.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
import { VizPanel } from "@/components/screens/run-detail/explore-tab/viz-panel";
import { directLakeApi } from "@/lib/api/lake";
import { runsApi } from "@/lib/api/runs";
import { resolveLakeSchema } from "@/lib/explore/lake-schema";

afterEach(() => {
  vi.restoreAllMocks();
});

const run = {
  run_id: "TAS-88214",
  started_at: "2026-08-20T10:41:07Z",
  ended_at: "2026-08-20T12:18:52Z",
} as TestRun;

function renderPanel(onOpenInSql = vi.fn()) {
  vi.spyOn(runsApi, "get").mockResolvedValue(run);
  vi.spyOn(directLakeApi, "query").mockImplementation(() => new Promise(() => undefined));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      {/* The v3 physical schema — the SQL bar must show ts_ms, never the
          logical `timestamp` spelling. */}
      <VizPanel
        runId="TAS-88214"
        schema={resolveLakeSchema("test_signal_samples_v3")}
        signalNames={["HV_Batt_Cell_Temp_Max", "HV_Batt_Pack_Voltage"]}
        onOpenInSql={onOpenInSql}
      />
    </QueryClientProvider>,
  );
  return onOpenInSql;
}

describe("VizPanel SQL bar", () => {
  it("is collapsed by default and expands to the generated statement", async () => {
    const user = userEvent.setup();
    renderPanel();
    const toggle = screen.getByRole("button", { name: /the query this chart runs/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The generated statement is visible once the run's time range loads
    // (time_bucket appears once per reference in the highlighted SQL).
    const matches = await screen.findAllByText(/time_bucket/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("hands the statement to the open-in-SQL callback", async () => {
    const user = userEvent.setup();
    const onOpenInSql = renderPanel();
    await user.click(screen.getByRole("button", { name: /the query this chart runs/ }));
    await screen.findAllByText(/time_bucket/);
    await user.click(screen.getByRole("button", { name: "Open in SQL tab" }));
    expect(onOpenInSql).toHaveBeenCalledTimes(1);
    expect(onOpenInSql.mock.calls[0][0]).toContain("time_bucket");
    expect(onOpenInSql.mock.calls[0][0]).toContain("HV_Batt_Cell_Temp_Max");
    // The handed-over statement uses the physical spellings verbatim.
    expect(onOpenInSql.mock.calls[0][0]).toContain("FROM test_signal_samples_v3");
    expect(onOpenInSql.mock.calls[0][0]).toContain("ts_ms");
    expect(onOpenInSql.mock.calls[0][0]).not.toContain(" timestamp ");
  });
});
