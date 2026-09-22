/**
 * TR-006 — the Results tab must not print two versions as two identical rows.
 *
 * A re-run of the same tool mints version 2 of the same result key. The tab
 * used to ask `GET /results?run=…` with no `latest_only`, and it printed no
 * version, so the two rows read as duplicates. The test drives the real path:
 * the tab, the hook, the API client and `fetch`. Only `fetch` is a stub, so
 * the query string the browser sends is the thing under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { ResultsTab } from "@/components/screens/run-detail/results-tab";

const RUN_ID = "TAS-88214";
const FILE_ID = "f-11111111-2222-3333-4444-555555555555";

/** Every `GET /results` query string the app sent, in order. */
let resultQueries: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function storedResult(version: number, supersedes: string | null): Record<string, unknown> {
  return {
    result_id: `res-${version}`,
    run_id: RUN_ID,
    name: "thermal_summary.parquet",
    result_key: "thermal_summary",
    version,
    supersedes,
    description: "Cycle-level aggregates",
    storage_ref: `blob://ws/test-manager/results/${RUN_ID}/thermal_summary_v${version}.parquet`,
    provenance: {
      tool: "bat-post",
      tool_version: "2.3.1",
      parameters: "--cycles all --dt 0.1",
      input_file_ids: [FILE_ID],
      produced_by: "Erika Lindqvist",
      produced_at: "2026-08-14T12:02:00Z",
    },
    provenance_status: "verified",
    created_at: `2026-08-14T12:0${version}:31Z`,
  };
}

/** Both versions of one result key. The newest is version 2. */
const CHAIN = [storedResult(2, "res-1"), storedResult(1, null)];

/** The stub answers `latest_only` the way the API does, so the rows are real. */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/proxy/results") {
        resultQueries.push(url.search);
        const items =
          url.searchParams.get("latest_only") === "true" ? [CHAIN[0]] : CHAIN;
        return json({ items, total: items.length, page: 1, page_size: 20, total_pages: 1 });
      }
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/files`) {
        return json({ items: [{ file_id: FILE_ID, filename: "bat_cyc_0814.mf4" }] });
      }
      throw new TypeError(`no stub for ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The data rows of the results table, header row excluded. */
function dataRows(): HTMLElement[] {
  const table = screen.getByRole("table", { name: "Processed results of this run" });
  return Array.from(table.querySelectorAll("tbody tr"));
}

/* The wrapping label names the box as well as its own aria-label, so the
   accessible name repeats the words. Match it, do not spell it twice. */
const EVERY_VERSION = /Show every version/;

beforeEach(() => {
  resultQueries = [];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Results tab separates the versions of one result", () => {
  it("asks for the newest version of each key, and prints one row", async () => {
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });

    await screen.findByText("v2");
    expect(dataRows()).toHaveLength(1);
    expect(resultQueries[0]).toContain("latest_only=true");
    expect(screen.queryByText("v1")).not.toBeInTheDocument();
  });

  it("prints both versions, each with its own number, when a person asks", async () => {
    const user = userEvent.setup();
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText("v2");

    await user.click(screen.getByRole("checkbox", { name: EVERY_VERSION }));

    await screen.findByText("v1");
    await waitFor(() => expect(dataRows()).toHaveLength(2));
    expect(resultQueries.some((query) => query.includes("latest_only=false"))).toBe(true);
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    // The newer row states what it replaces, so the two rows never read alike.
    expect(screen.getByText(/replaces res-1/)).toBeInTheDocument();
  });

  it("names the version column in the table header", async () => {
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });

    await screen.findByText("v2");
    expect(screen.getByRole("columnheader", { name: "Version" })).toBeInTheDocument();
  });
});
