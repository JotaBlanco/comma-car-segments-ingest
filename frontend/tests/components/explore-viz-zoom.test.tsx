/**
 * Visualise drag-zoom. Unlike the SQL-bar test, this one lets the query
 * RESOLVE so the chart effect runs and we can capture the Chart.js config the
 * panel builds — the zoom callback only exists inside it.
 *
 * The bug this guards: chartjs-plugin-zoom fires `onZoomComplete` from inside
 * `resetZoom` itself (2.2.0, dist/chartjs-plugin-zoom.esm.js:388). A handler
 * that called `chart.resetZoom()` therefore recursed without bound, running a
 * full `chart.update()` every lap, synchronously inside the mouseup handler.
 * The tab froze. The fake chart below reproduces that plugin behaviour, so a
 * handler that reaches for resetZoom fails this suite instead of the browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TestRun } from "@/types";

// jsdom has no ResizeObserver. This one records the callback so a test can
// drive a width change by hand.
let resizeFire: ((entries: unknown[]) => void) | null = null;
class ResizeObserverStub {
  constructor(callback: (entries: unknown[]) => void) {
    resizeFire = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// Capture every config handed to `new Chart(...)`; the real Chart.js needs a
// 2D canvas context jsdom does not provide.
const chartConfigs: Record<string, unknown>[] = [];
vi.mock("chart.js/auto", () => {
  class ChartStub {
    static register = vi.fn();
    constructor(_canvas: unknown, config: Record<string, unknown>) {
      chartConfigs.push(config);
    }
    destroy() {}
  }
  return { default: ChartStub };
});

import { VizPanel } from "@/components/screens/run-detail/explore-tab/viz-panel";
import { directLakeApi } from "@/lib/api/lake";
import { runsApi } from "@/lib/api/runs";
import { resolveLakeSchema } from "@/lib/explore/lake-schema";

const run = {
  run_id: "TAS-88214",
  started_at: "2026-08-20T10:41:07Z",
  ended_at: "2026-08-20T12:18:52Z",
} as TestRun;

/** Two points per signal — enough for the panel to build a series. */
const rows = [
  ["HV_Batt_Cell_Temp_Max", "1755686467000", "41.2"],
  ["HV_Batt_Cell_Temp_Max", "1755686468000", "41.9"],
  ["HV_Batt_Pack_Voltage", "1755686467000", "398.1"],
  ["HV_Batt_Pack_Voltage", "1755686468000", "397.4"],
];

interface ZoomHandlerArg {
  chart: {
    scales: { x?: { min: number; max: number } };
    resetZoom: () => void;
  };
}
type ZoomHandler = (arg: ZoomHandlerArg) => void;

/** The zoom callback out of the most recent chart config. */
function latestZoomHandler(): ZoomHandler {
  const config = chartConfigs[chartConfigs.length - 1];
  const options = config.options as {
    plugins: { zoom: { zoom: { onZoomComplete: ZoomHandler } } };
  };
  return options.plugins.zoom.zoom.onZoomComplete;
}

function latestZoomOptions(): Record<string, Record<string, unknown>> {
  const config = chartConfigs[chartConfigs.length - 1];
  const options = config.options as {
    plugins: { zoom: Record<string, Record<string, unknown>> };
  };
  return options.plugins.zoom;
}

let queryMock: ReturnType<typeof vi.fn>;

function renderPanel() {
  vi.spyOn(runsApi, "get").mockResolvedValue(run);
  queryMock = vi.fn().mockResolvedValue({ columns: ["signal", "ts", "value"], rows });
  vi.spyOn(directLakeApi, "query").mockImplementation(
    queryMock as unknown as typeof directLakeApi.query,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VizPanel
        runId="TAS-88214"
        schema={resolveLakeSchema("test_signal_samples_v3")}
        signalNames={["HV_Batt_Cell_Temp_Max", "HV_Batt_Pack_Voltage"]}
      />
    </QueryClientProvider>,
  );
}

/** The SQL of every lake call so far. */
function issuedSql(): string[] {
  return queryMock.mock.calls.map((call) => (call[0] as { sql: string }).sql);
}

beforeEach(() => {
  chartConfigs.length = 0;
  resizeFire = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VizPanel drag-zoom", () => {
  it("does not recurse when the plugin re-fires onZoomComplete from resetZoom", async () => {
    renderPanel();
    await waitFor(() => expect(chartConfigs.length).toBeGreaterThan(0));
    const handler = latestZoomHandler();

    let resetCalls = 0;
    const chart: ZoomHandlerArg["chart"] = {
      scales: { x: { min: 1_755_686_467_000, max: 1_755_686_468_000 } },
      // Exactly what chartjs-plugin-zoom does: resetZoom re-enters the
      // callback. Blow up rather than hang if the handler calls it in a loop.
      resetZoom: () => {
        resetCalls += 1;
        if (resetCalls > 20) throw new Error("onZoomComplete recursed through resetZoom");
        handler({ chart });
      },
    };

    expect(() => handler({ chart })).not.toThrow();
    // The fix is not "recurse less" but "never reset from the callback" — the
    // rebuilt chart discards the zoom on its own when the new data lands.
    expect(resetCalls).toBe(0);
  });

  it("re-queries the narrowed window once", async () => {
    renderPanel();
    await waitFor(() => expect(chartConfigs.length).toBeGreaterThan(0));
    const before = issuedSql().length;

    latestZoomHandler()({
      chart: {
        scales: { x: { min: Date.parse("2026-08-20T11:00:00Z"), max: Date.parse("2026-08-20T11:05:00Z") } },
        resetZoom: () => undefined,
      },
    });

    await waitFor(() => expect(issuedSql().length).toBe(before + 1));
    const sql = issuedSql()[before];
    expect(sql).toContain(
      `BETWEEN ${Date.parse("2026-08-20T11:00:00Z")} AND ${Date.parse("2026-08-20T11:05:00Z")}`,
    );
  });

  it("ignores a degenerate drag whose scale bounds are not finite", async () => {
    renderPanel();
    await waitFor(() => expect(chartConfigs.length).toBeGreaterThan(0));
    const before = issuedSql().length;

    // new Date(NaN).toISOString() throws a RangeError, and it would throw
    // inside the plugin's own callback where nothing catches it.
    expect(() =>
      latestZoomHandler()({
        chart: { scales: { x: { min: NaN, max: NaN } }, resetZoom: () => undefined },
      }),
    ).not.toThrow();
    expect(issuedSql().length).toBe(before);
  });

  it("bounds the gesture with a minimum range and a drag threshold", async () => {
    renderPanel();
    await waitFor(() => expect(chartConfigs.length).toBeGreaterThan(0));
    const zoom = latestZoomOptions();
    expect((zoom.limits as { x: { minRange: number } }).x.minRange).toBeGreaterThan(0);
    expect((zoom.zoom.drag as { threshold: number }).threshold).toBeGreaterThan(0);
  });

  it("does not re-query when a resize does not move the quantised width", async () => {
    renderPanel();
    await waitFor(() => expect(chartConfigs.length).toBeGreaterThan(0));
    const before = issuedSql().length;

    // A one-pixel wobble — a legend gaining a scrollbar, or the canvas the
    // rebuild just resized inside the observed element.
    resizeFire?.([{ contentRect: { width: 721 } }]);
    resizeFire?.([{ contentRect: { width: 719 } }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(issuedSql().length).toBe(before);
  });
});
