/**
 * FR-DM-075 — the upload action on Home.
 *
 * Home mounts no second uploader. It mounts the one dialog the run detail
 * Results tab already mounts (`run-detail/upload-result-dialog.tsx`), so both
 * screens send the same request and answer the same refusals. The dialog needs
 * a run, and Home names none, so a person picks one from the same debounced
 * `GET /test-runs?q=` picker `files/link-run-dialog.tsx` uses.
 *
 * The test drives the real path: the screen, the picker, the dialog and the
 * hooks. Only `fetch` and the router are stubs.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { HomeSummary, TestRunListItem } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { HomeScreen } from "@/components/screens/home/home-screen";
import { resetFavouritesCache } from "@/lib/favourites";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";

// Each test drives a real dialog through user-event, so it takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const PORTAL_API = "https://portal-api.dev.quix.io";
/** The name the Portal profile resolves to. The dialog prints it. */
const PORTAL_NAME = "Erika Lindqvist";

/** Every request the app sent, in order. */
let calls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function summary(): HomeSummary {
  return {
    counts: {
      test_runs: 12,
      files: 30,
      signals: 186,
      work_orders: 4,
      runs_today: 1,
      files_today: 2,
      rig_count: 3,
    },
    needs_attention: { awaiting_work_order: 0, quarantined_files: 0, invalid_runs: 0 },
    planning_sync: { online: true, last_sync_at: "2026-08-19T07:00:00Z" },
    recent_runs: [],
  };
}

function runRow(run_id: string, description: string | null): TestRunListItem {
  return {
    run_id,
    description,
    definition_id: null,
    work_order_id: null,
    project: null,
    rig_id: "RIG-04",
    test_cell: null,
    file_count: 0,
    signal_count: 0,
    first_data_at: "2026-08-14T10:02:00Z",
    status: "complete",
    invalid: { flagged: false, reason: null, actor: null, at: null },
  };
}

const RUNS = [
  runRow("TAS-88214", "E-machine efficiency map"),
  runRow("TAS-88215", "Inverter derating sweep"),
];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      calls.push(`${(init.method ?? "GET").toUpperCase()} ${url.pathname}${url.search}`);
      if (url.pathname === "/profile") {
        return json({
          userId: "u-1",
          email: "e.lindqvist@volvo.com",
          firstName: "Erika",
          lastName: "Lindqvist",
        });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });
      if (url.pathname === "/api/proxy/home/summary") return json(summary());
      if (url.pathname === "/api/proxy/test-runs") {
        const q = url.searchParams.get("q")?.toLowerCase() ?? "";
        const items = RUNS.filter(
          (run) =>
            q.length === 0 ||
            run.run_id.toLowerCase().includes(q) ||
            (run.description ?? "").toLowerCase().includes(q),
        );
        return json({ items, total: items.length, page: 1, page_size: 200, total_pages: 1 });
      }
      if (/^\/api\/proxy\/test-runs\/[^/]+\/files$/.test(url.pathname)) {
        return json({ items: [], total: 0 });
      }
      throw new TypeError(`no stub for ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.clear();
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  resetFavouritesCache();
  calls = [];
  stubFetch();
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  resetFavouritesCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the quick actions block on Home", () => {
  it("mounts the favourites panel and the upload action", async () => {
    render(<HomeScreen />, { wrapper: Wrapper });

    expect(await screen.findByRole("table", { name: "Favorites" })).toBeInTheDocument();
    expect(screen.getByText("Quick actions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload result" })).toBeInTheDocument();
  });

  it("holds the upload closed until a person picks a run", async () => {
    render(<HomeScreen />, { wrapper: Wrapper });

    expect(await screen.findByRole("button", { name: "Upload result" })).toBeDisabled();
    expect(screen.getByText(/Pick a run first/)).toBeInTheDocument();
    // A dialog nobody opened asks the registry for no run file.
    expect(calls.some((call) => call.includes("/files"))).toBe(false);
  });

  it("opens the run detail upload dialog for the picked run", async () => {
    const user = userEvent.setup();
    render(<HomeScreen />, { wrapper: Wrapper });

    await user.click(await screen.findByLabelText("Run"));
    await user.click(await screen.findByRole("option", { name: /TAS-88215/ }));

    const upload = screen.getByRole("button", { name: "Upload result" });
    await waitFor(() => expect(upload).toBeEnabled());
    await user.click(upload);

    // The dialog is the run detail one: same title, same provenance fields.
    expect(
      await screen.findByRole("heading", { name: "Upload a processed result to TAS-88215" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Tool")).toBeInTheDocument();
    expect(screen.getByLabelText("Result key")).toBeInTheDocument();
    expect(await screen.findByText(PORTAL_NAME)).toBeInTheDocument();
    // Only now does it read the run's files, for the input-file list.
    await waitFor(() =>
      expect(calls.some((call) => call.includes("/test-runs/TAS-88215/files"))).toBe(true),
    );
  });

  it("searches the whole registry from the picker, not one page", async () => {
    const user = userEvent.setup();
    render(<HomeScreen />, { wrapper: Wrapper });

    await user.type(await screen.findByLabelText("Run"), "derating");

    expect(await screen.findByRole("option", { name: /TAS-88215/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((call) => call.includes("q=derating"))).toBe(true),
    );
  });
});
