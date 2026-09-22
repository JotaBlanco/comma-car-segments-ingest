/**
 * FR-DM-042 — the Archived and the Deleted view of the files screen.
 *
 * The plain table holds the active files only, so an archived file left the
 * table with nowhere to go. The route already serves `lifecycle=archived` and
 * `lifecycle=deleted` (`api/api/routers/files.py`). The test drives the real
 * path: the screen, the URL state, the hook, the API client and `fetch`. Only
 * `fetch` and the router are stubs, so the query string the browser sends is
 * the thing under test.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { FileEntity, FileLifecycle } from "@/types";

const { nav } = vi.hoisted(() => ({
  nav: { search: "", pushes: [] as string[] },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => nav.pushes.push(href),
    replace: (href: string) => nav.pushes.push(href),
  }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { FilesScreen } from "@/components/screens/files/files-screen";

/** Every `GET /files` query string the app sent, in order. */
let fileQueries: string[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fileRow(lifecycle: FileLifecycle): FileEntity {
  return {
    file_id: `f-${lifecycle}`,
    filename: `bat_cyc_${lifecycle}.mf4`,
    run_id: "TAS-88214",
    source_system: "TAS",
    format: "MF4",
    size_bytes: 4096,
    checksum_sha256: "a".repeat(64),
    checksum_state: "verified",
    status: "registered",
    quarantine_reason: null,
    lifecycle,
    version: 1,
    sync_status: "success",
    upload_status: "success",
    conversion_status: "success",
    stage_error: null,
    signal_count: 2,
    time_start: "2026-08-14T09:00:00Z",
    time_end: "2026-08-14T11:00:00Z",
    registered_at: "2026-08-14T10:02:00Z",
  };
}

/** The route answers the view the query names, the way the API does. */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost:3000");
      if (url.pathname === "/api/proxy/files") {
        fileQueries.push(url.search);
        const asked = (url.searchParams.getAll("lifecycle") as FileLifecycle[])[0] ?? "active";
        const items = [fileRow(asked)];
        return json({
          items,
          total: 1,
          page: 1,
          page_size: 20,
          total_pages: 1,
          view_counts: { all: 7, registered: 6, quarantined: 1, archived: 3, deleted: 2 },
        });
      }
      throw new TypeError(`no stub for ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The one `GET /files` the app sent last. */
function lastQuery(): string {
  return fileQueries[fileQueries.length - 1];
}

beforeEach(() => {
  nav.search = "";
  nav.pushes = [];
  fileQueries = [];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the files screen offers the archive and the recycle bin", () => {
  it("names both views in the quick views, each with its own count", async () => {
    render(<FilesScreen />, { wrapper: Wrapper });

    const archived = await screen.findByRole("button", { name: /^Archived/ });
    const deleted = await screen.findByRole("button", { name: /^Deleted/ });
    expect(archived).toHaveTextContent("3");
    expect(deleted).toHaveTextContent("2");
  });

  it("asks for no lifecycle on the plain table, so the API serves the active files", async () => {
    render(<FilesScreen />, { wrapper: Wrapper });

    await waitFor(() => expect(fileQueries).not.toHaveLength(0));
    expect(lastQuery()).not.toContain("lifecycle");
    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("writes lifecycle=archived into the URL when a person picks the Archived view", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /^Archived/ }));

    expect(nav.pushes).toContain("/files?lifecycle=archived");
  });

  it("writes lifecycle=deleted into the URL when a person picks the Deleted view", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /^Deleted/ }));

    expect(nav.pushes).toContain("/files?lifecycle=deleted");
  });

  for (const view of ["archived", "deleted"] as const) {
    it(`sends lifecycle=${view} and badges the row when the URL names that view`, async () => {
      nav.search = `lifecycle=${view}`;
      render(<FilesScreen />, { wrapper: Wrapper });

      await waitFor(() => expect(lastQuery()).toContain(`lifecycle=${view}`));
      const label = view === "archived" ? "Archived" : "Deleted";
      // The badge sits in the row, beside the status badge, never instead of it.
      const row = await screen.findByText(`bat_cyc_${view}.mf4`);
      const cells = row.closest("tr");
      expect(cells).not.toBeNull();
      expect(cells).toHaveTextContent(label);
      expect(cells).toHaveTextContent("Registered");
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  }

  it("prints no lifecycle badge on an active row", async () => {
    render(<FilesScreen />, { wrapper: Wrapper });

    const row = (await screen.findByText("bat_cyc_active.mf4")).closest("tr");
    expect(row).not.toHaveTextContent("Active");
  });
});
