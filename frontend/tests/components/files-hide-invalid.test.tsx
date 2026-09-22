/**
 * "Hide invalid files" on the files screen.
 *
 * `GET /files` already took an `invalid` parameter and the screen never sent
 * it. These tests drive the real path — the screen, the URL state, the hook,
 * the API client and `fetch` — so the query string the browser sends is the
 * thing under test. Only `fetch` and the router are stubs.
 *
 * The rule the tests defend: hiding is a choice, never a default. A screen
 * that nobody touched must send no `invalid` key at all.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { FileEntity } from "@/types";

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

function fileRow(flagged: boolean): FileEntity {
  return {
    file_id: flagged ? "f-bad" : "f-good",
    filename: flagged ? "bat_cyc_bad.mf4" : "bat_cyc_good.mf4",
    run_id: "TAS-88214",
    source_system: "TAS",
    format: "MF4",
    size_bytes: 4096,
    checksum_sha256: "a".repeat(64),
    checksum_state: "verified",
    status: "registered",
    quarantine_reason: null,
    lifecycle: "active",
    invalid: flagged
      ? { flagged: true, reason: "Thermocouple came loose", actor: "ana", at: "2026-08-24T09:00:00Z" }
      : undefined,
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

/** The route honours `invalid` the way the real one does. */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost:3000");
      if (url.pathname === "/api/proxy/files") {
        fileQueries.push(url.search);
        const asked = url.searchParams.get("invalid");
        const items =
          asked === "false"
            ? [fileRow(false)]
            : asked === "true"
              ? [fileRow(true)]
              : [fileRow(false), fileRow(true)];
        return json({
          items,
          total: items.length,
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

/** The panel is shut while no filter is on, so the tick lives one click away. */
async function openFilters(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const button = await screen.findByRole("button", { name: /^Filters/ });
  if (button.getAttribute("aria-expanded") === "false") await user.click(button);
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

describe("the files screen can hide the invalid files", () => {
  it("offers the tick in the filter panel", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await openFilters(user);

    const tick = screen.getByRole("checkbox", { name: "Hide invalid files" });
    expect(tick).toHaveAttribute("aria-checked", "false");
  });

  it("sends no invalid key at all on the default view, so every file still shows", async () => {
    render(<FilesScreen />, { wrapper: Wrapper });

    await waitFor(() => expect(fileQueries).not.toHaveLength(0));
    // The whole point: the default must not change. No key, not `invalid=true`.
    expect(new URLSearchParams(lastQuery()).has("invalid")).toBe(false);
    expect(await screen.findByText("bat_cyc_bad.mf4")).toBeInTheDocument();
    expect(screen.getByText("bat_cyc_good.mf4")).toBeInTheDocument();
    // The default view is still `All`, and no invalid pill is on. The flagged
    // ROW still wears its own "Invalid" badge, so the pill is what to look for.
    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /^Remove filter: Invalid/ })).toBeNull();
  });

  it("writes invalid=false into the URL when a person ticks the box", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await openFilters(user);
    await user.click(screen.getByRole("checkbox", { name: "Hide invalid files" }));

    expect(nav.pushes).toContain("/files?invalid=false");
  });

  it("sends invalid=false and drops the flagged row when the URL carries it", async () => {
    nav.search = "invalid=false";
    render(<FilesScreen />, { wrapper: Wrapper });

    await waitFor(() => expect(lastQuery()).toContain("invalid=false"));
    expect(await screen.findByText("bat_cyc_good.mf4")).toBeInTheDocument();
    expect(screen.queryByText("bat_cyc_bad.mf4")).not.toBeInTheDocument();
  });

  it("shows the tick as on, and the state in a pill, when the URL carries it", async () => {
    const user = userEvent.setup();
    nav.search = "invalid=false";
    render(<FilesScreen />, { wrapper: Wrapper });

    // A URL that already filters opens the panel on arrival.
    await openFilters(user);
    expect(screen.getByRole("checkbox", { name: "Hide invalid files" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Remove filter: Invalid Hidden" }),
    ).toBeInTheDocument();
  });

  it("removes the key when a person unticks the box", async () => {
    const user = userEvent.setup();
    nav.search = "invalid=false";
    render(<FilesScreen />, { wrapper: Wrapper });

    await openFilters(user);
    await user.click(screen.getByRole("checkbox", { name: "Hide invalid files" }));

    // Back to the default URL: no `invalid` key, not `invalid=true`.
    expect(nav.pushes).toContain("/files");
  });

  it("removes the key when a person clears the pill", async () => {
    const user = userEvent.setup();
    nav.search = "invalid=false";
    render(<FilesScreen />, { wrapper: Wrapper });

    await user.click(
      await screen.findByRole("button", { name: "Remove filter: Invalid Hidden" }),
    );

    expect(nav.pushes).toContain("/files");
  });

  it("keeps hiding on when a person picks a quick view, because the two combine", async () => {
    const user = userEvent.setup();
    nav.search = "invalid=false";
    render(<FilesScreen />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /^Registered/ }));

    // A quick view is exclusive over the keys it owns. It must not own this one.
    expect(nav.pushes).toContain("/files?status=registered&invalid=false");
  });

  it("still highlights the quick view while hiding is on", async () => {
    nav.search = "status=registered&invalid=false";
    render(<FilesScreen />, { wrapper: Wrapper });

    expect(await screen.findByRole("button", { name: /^Registered/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("turns hiding off with Clear all, because Clear all means all", async () => {
    const user = userEvent.setup();
    nav.search = "invalid=false";
    render(<FilesScreen />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /Clear all/i }));

    expect(nav.pushes).toContain("/files");
  });
});
