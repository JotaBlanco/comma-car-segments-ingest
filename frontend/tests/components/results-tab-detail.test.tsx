/**
 * TR-006, the second clause — a result version has an address and a download.
 *
 * `c80b2b7` closed the first clause: the tab prints a version and hides the
 * older ones. The row's own clause stayed open — `GET /results/{result_id}`
 * did not exist, and neither did its download, so a version had no address.
 * The routes exist now (contract §B #18b and #18c), and this test drives the
 * screen that reaches them: the tab, the dialog, the hooks, the API client and
 * `fetch`. Only `fetch` is a stub, so the request the browser sends is the
 * thing under test.
 *
 * A result that names no `storage_ref` holds no bytes here. The row's button
 * must say so and must never fire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { ResultsTab } from "@/components/screens/run-detail/results-tab";

const RUN_ID = "TAS-88214";
const FILE_ID = "f-11111111-2222-3333-4444-555555555555";
const WITH_BYTES = "res-with-bytes";
const NO_BYTES = "res-no-bytes";
const PAYLOAD = "cycle,peak_temp\n1,41.2\n";

/** Every path the app fetched, in order. */
let requested: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function storedResult(resultId: string, storageRef: string | null): Record<string, unknown> {
  return {
    result_id: resultId,
    run_id: RUN_ID,
    name: `${resultId}.parquet`,
    result_key: resultId,
    version: 1,
    supersedes: null,
    description: "Cycle-level aggregates",
    storage_ref: storageRef,
    provenance: {
      tool: "bat-post",
      tool_version: "2.3.1",
      parameters: "--cycles all --dt 0.1",
      input_file_ids: [FILE_ID],
      produced_by: "Erika Lindqvist",
      produced_at: "2026-08-14T12:02:00Z",
    },
    provenance_status: "verified",
    created_at: "2026-08-14T12:02:31Z",
  };
}

const ROWS = [storedResult(WITH_BYTES, "blob://ws/results/x.parquet"), storedResult(NO_BYTES, null)];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      requested.push(url.pathname);
      if (url.pathname === "/api/proxy/results") {
        return json({ items: ROWS, total: 2, page: 1, page_size: 20, total_pages: 1 });
      }
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/files`) {
        return json({ items: [{ file_id: FILE_ID, filename: "bat_cyc_0814.mf4" }] });
      }
      if (url.pathname === `/api/proxy/results/${WITH_BYTES}`) {
        // The stored version answers a description the row never carried, so a
        // passing assertion proves the dialog read the route.
        return json({ ...storedResult(WITH_BYTES, "blob://ws/results/x.parquet"), description: "Read from the registry" });
      }
      if (url.pathname === `/api/proxy/results/${WITH_BYTES}/download`) {
        return new Response(PAYLOAD, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${WITH_BYTES}.parquet"`,
            "x-journal-id": "j-1",
          },
        });
      }
      throw new TypeError(`no stub for ${input}`);
    }),
  );
}

/** The table row that prints a given result name. */
function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(name) !== null);
  if (row === undefined) throw new Error(`no row prints ${name}`);
  return row;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  requested = [];
  stubFetch();
  // jsdom has no blob download. Keep the anchor click from leaving the page.
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Results tab opens one result version and downloads it", () => {
  it("asks nothing extra until a person opens a result", async () => {
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });

    await screen.findByText(`${WITH_BYTES}.parquet`);
    expect(requested).not.toContain(`/api/proxy/results/${WITH_BYTES}`);
  });

  it("reads the version back through its own id when the row is clicked", async () => {
    const user = userEvent.setup();
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${WITH_BYTES}.parquet`);

    await user.click(rowOf(`${WITH_BYTES}.parquet`));

    await waitFor(() =>
      expect(requested).toContain(`/api/proxy/results/${WITH_BYTES}`),
    );
    // The value only the route carries proves the dialog shows the read.
    await screen.findByText("Read from the registry");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("downloads the bytes through the proxy, with no token in the URL", async () => {
    const user = userEvent.setup();
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${WITH_BYTES}.parquet`);

    await user.click(screen.getByRole("button", { name: `Download ${WITH_BYTES}.parquet` }));

    await waitFor(() =>
      expect(requested).toContain(`/api/proxy/results/${WITH_BYTES}/download`),
    );
    const downloadCall = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls.find(
      ([url]) => url.includes("/download"),
    );
    expect(downloadCall?.[0]).not.toContain("?");
    expect(downloadCall?.[0]).not.toMatch(/token/i);
  });

  /* The owner asked for an edit button in place of a link on the name. The
     name is plain text now, the row opens the result to read, and the pencil
     opens the same dialog with the edit form up. The download stays apart from
     both. */
  it("opens the result in edit mode from the pencil in the action column", async () => {
    const user = userEvent.setup();
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${WITH_BYTES}.parquet`);

    await user.click(screen.getByRole("button", { name: `Edit ${WITH_BYTES}.parquet` }));

    // A box only the edit form carries proves the dialog opened ready to edit.
    expect(await screen.findByLabelText("Tool version")).toBeInTheDocument();
  });

  it("leaves the name as text, so it is no longer a control", async () => {
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${WITH_BYTES}.parquet`);

    expect(screen.queryByRole("button", { name: `${WITH_BYTES}.parquet` })).toBeNull();
    // Nothing offers a third way in beside the row and the pencil.
    expect(
      screen.queryByRole("button", { name: `Open details for ${WITH_BYTES}.parquet` }),
    ).toBeNull();
  });

  it("downloads from the row without opening the result", async () => {
    const user = userEvent.setup();
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${WITH_BYTES}.parquet`);

    await user.click(screen.getByRole("button", { name: `Download ${WITH_BYTES}.parquet` }));

    await waitFor(() =>
      expect(requested).toContain(`/api/proxy/results/${WITH_BYTES}/download`),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses to download a result that names no stored file", async () => {
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${NO_BYTES}.parquet`);

    const button = screen.getByRole("button", {
      name: `Download disabled: ${NO_BYTES}.parquet names no stored file, so there is nothing to download`,
    });

    expect(button).toBeDisabled();
    expect(requested).not.toContain(`/api/proxy/results/${NO_BYTES}/download`);
  });
});
