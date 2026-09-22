/**
 * FR-DM-078 — multi-select, the two batch writes and the batch download on
 * the files screen.
 *
 * The screen picks rows, then loops the single-file routes:
 * `POST /files/{file_id}/invalid-flag`, `POST /files/{file_id}/archive` and
 * `GET /files/{file_id}/download` (`api/api/routers/files.py`). No batch
 * route exists, and this suite proves the screen adds none. The download
 * route writes its `file.downloaded` journal row before the first byte, so
 * one call per file keeps the audit trail exact.
 *
 * Each test drives the real path: the screen, the URL state, the hooks, the API
 * client and `fetch`. Only `fetch` and the router are stubs, so the requests the
 * browser sends are the thing under test.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`. This file
 * sits in that folder, so that config and no other picks it up:
 * `tests/unit/**` and `tests/contract*.test.ts` both miss it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { FileEntity } from "@/types";

/* The router mock is REACTIVE: a push rewrites the search string and wakes
   every `useSearchParams` caller. Without that a quick-view click would record
   a URL and change no state, so "a filter change clears the selection" could
   never be read. */
const { nav } = vi.hoisted(() => {
  const nav = {
    search: "",
    pushes: [] as string[],
    listeners: new Set<() => void>(),
    go: (href: string) => {
      nav.pushes.push(href);
      const mark = href.indexOf("?");
      nav.search = mark === -1 ? "" : href.slice(mark + 1);
      for (const listener of [...nav.listeners]) listener();
    },
  };
  return { nav };
});

vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useRouter: () => ({
      push: nav.go,
      replace: nav.go,
      refresh: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
    }),
    usePathname: () => "/files",
    useSearchParams: () => {
      const search = useSyncExternalStore(
        (onChange: () => void) => {
          nav.listeners.add(onChange);
          return () => {
            nav.listeners.delete(onChange);
          };
        },
        () => nav.search,
        () => nav.search,
      );
      return new URLSearchParams(search);
    },
  };
});

import { FilesScreen } from "@/components/screens/files/files-screen";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";

// Each test drives a real dialog through user-event, so it takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const PORTAL_API = "https://portal-api.dev.quix.io";
/** The name the Portal profile resolves to. Every write must carry it. */
const PORTAL_NAME = "Erika Lindqvist";
const REASON = "Cell 7 thermocouple came loose at 10:12";

/** Every request the app sent, in order. */
let calls: Array<{ url: string; method: string; body: string | null }> = [];
/** How many writes were in flight at once. The batch must never race itself. */
let peakInFlight = 0;
/** Answer a write or a download with a refusal instead of a 200, per file id. */
let refuse: Record<string, { status: number; code: string }> = {};
/** When set, every download waits on it — the cancel test holds the batch open. */
let downloadHold: Promise<void> | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fileRow(id: string, overrides: Partial<FileEntity> = {}): FileEntity {
  return {
    file_id: id,
    filename: `${id}.mf4`,
    run_id: "TAS-88214",
    source_system: "TAS",
    format: "MF4",
    size_bytes: 4096,
    checksum_sha256: "a".repeat(64),
    checksum_state: "verified",
    status: "registered",
    quarantine_reason: null,
    lifecycle: "active",
    version: 1,
    sync_status: "success",
    upload_status: "success",
    conversion_status: "success",
    stage_error: null,
    signal_count: 2,
    time_start: "2026-08-14T09:00:00Z",
    time_end: "2026-08-14T11:00:00Z",
    registered_at: "2026-08-14T10:02:00Z",
    ...overrides,
  };
}

const ROWS = [fileRow("alpha"), fileRow("bravo"), fileRow("charlie")];

function stubFetch(rows: readonly FileEntity[] = ROWS): void {
  let inFlight = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost:3000");
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ url: url.pathname, method, body: (init.body as string) ?? null });

      if (url.pathname === "/profile") {
        return json({
          userId: "u-1",
          email: "e.lindqvist@volvo.com",
          firstName: "Erika",
          lastName: "Lindqvist",
        });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });

      if (url.pathname === "/api/proxy/files") {
        return json({
          items: rows,
          total: rows.length,
          page: 1,
          page_size: 20,
          total_pages: 1,
          view_counts: {
            all: rows.length,
            registered: rows.length,
            quarantined: 0,
            archived: 0,
            deleted: 0,
          },
        });
      }

      const download = /^\/api\/proxy\/files\/([^/]+)\/download$/.exec(url.pathname);
      if (download !== null && method === "GET") {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        if (downloadHold !== null) await downloadHold;
        else await Promise.resolve();
        inFlight -= 1;
        const refusal = refuse[download[1]];
        if (refusal !== undefined) {
          return json(
            { detail: `refused: ${refusal.code}`, code: refusal.code, errors: [] },
            refusal.status,
          );
        }
        return new Response(`mock-bytes-${download[1]}`, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${download[1]}.mf4"`,
          },
        });
      }

      const write = /^\/api\/proxy\/files\/([^/]+)\/(invalid-flag|archive)$/.exec(url.pathname);
      if (write !== null && method === "POST") {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // A real call yields the event loop, so a parallel loop would show here.
        await Promise.resolve();
        inFlight -= 1;
        const refusal = refuse[write[1]];
        if (refusal !== undefined) {
          return json(
            { detail: `refused: ${refusal.code}`, code: refusal.code, errors: [] },
            refusal.status,
          );
        }
        return json(fileRow(write[1]));
      }

      throw new TypeError(`no stub for ${method} ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Every write the app sent to one of the two batch routes. */
function writeCalls(fragment: string) {
  return calls.filter((call) => call.method === "POST" && call.url.endsWith(fragment));
}

/** Tick the box of one row, by the filename the row shows. */
async function pick(user: ReturnType<typeof userEvent.setup>, id: string): Promise<void> {
  await user.click(await screen.findByRole("checkbox", { name: `Select ${id}.mf4` }));
}

/** Wait until the Portal name resolves, so no write races the identity. */
async function awaitIdentity(): Promise<void> {
  await waitFor(() =>
    expect(
      calls.some((call) => call.url === "/profile"),
    ).toBe(true),
  );
}

/* jsdom ships no `URL.createObjectURL`. The browser-download hand-off needs
   one, so the suite pins a stub and restores whatever stood before. */
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  nav.search = "";
  nav.pushes = [];
  nav.listeners.clear();
  calls = [];
  peakInFlight = 0;
  refuse = {};
  downloadHold = null;
  URL.createObjectURL = vi.fn(() => "blob:mock-url");
  URL.revokeObjectURL = vi.fn();
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  stubFetch();
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a person who picks nothing sees the screen it always was", () => {
  it("shows no batch bar and no batch button", async () => {
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    expect(screen.queryByRole("region", { name: /Batch actions/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark invalid" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("sends no write, and asks the registry for the list only", async () => {
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    const asked = calls.filter((call) => call.url.startsWith("/api/proxy/"));
    expect(asked.every((call) => call.url === "/api/proxy/files")).toBe(true);
  });

  it("leaves every row box clear, and the header box clear", async () => {
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    for (const box of screen.getAllByRole("checkbox")) expect(box).not.toBeChecked();
  });
});

describe("the header box picks the page", () => {
  it("picks every row on the page, and states the count", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await user.click(screen.getByRole("checkbox", { name: "Select every file on this page" }));

    const bar = await screen.findByRole("region", { name: /Batch actions/ });
    expect(bar).toHaveTextContent("3 files picked.");
  });

  it("drops the whole page on a second click", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    const header = screen.getByRole("checkbox", { name: "Select every file on this page" });
    await user.click(header);
    await screen.findByRole("region", { name: /Batch actions/ });
    await user.click(header);

    await waitFor(() => expect(screen.queryByRole("region", { name: /Batch actions/ })).toBeNull());
  });
});

describe("the confirmation states how many files it will touch", () => {
  it("names the count before it archives", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await pick(user, "alpha");
    await pick(user, "bravo");
    await user.click(screen.getByRole("button", { name: "Archive" }));

    expect(await screen.findByRole("heading", { name: "Archive 2 files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive 2" })).toBeInTheDocument();
    // The confirmation alone never writes.
    expect(writeCalls("/archive")).toHaveLength(0);
  });

  it("names the count before it marks files invalid", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await pick(user, "charlie");
    await user.click(screen.getByRole("button", { name: "Mark invalid" }));

    expect(
      await screen.findByRole("heading", { name: "Mark 1 file as invalid" }),
    ).toBeInTheDocument();
    expect(writeCalls("/invalid-flag")).toHaveLength(0);
  });

  it("keeps the batch back when a person cancels", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await pick(user, "alpha");
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("heading", { name: "Archive 1 file" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(writeCalls("/archive")).toHaveLength(0);
    // The pick survives the cancel, so nothing is lost by a second thought.
    expect(await screen.findByRole("region", { name: /Batch actions/ })).toHaveTextContent(
      "1 file picked.",
    );
  });
});

describe("the batch calls the single-file route once per picked file", () => {
  it("archives each picked file, one call at a time, and names the actor", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await awaitIdentity();
    await pick(user, "alpha");
    await pick(user, "charlie");
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("heading", { name: "Archive 2 files" });
    await user.click(screen.getByRole("button", { name: "Archive 2" }));

    await waitFor(() => expect(writeCalls("/archive")).toHaveLength(2));
    expect(writeCalls("/archive").map((call) => call.url)).toEqual([
      "/api/proxy/files/alpha/archive",
      "/api/proxy/files/charlie/archive",
    ]);
    // The unpicked row never takes a call.
    expect(calls.some((call) => call.url.includes("/bravo/"))).toBe(false);
    expect(peakInFlight).toBe(1);
    for (const call of writeCalls("/archive")) {
      expect(JSON.parse(call.body as string)).toMatchObject({ actor: PORTAL_NAME });
    }
  });

  it("marks each picked file invalid, and sends the one reason with every call", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await awaitIdentity();
    await user.click(screen.getByRole("checkbox", { name: "Select every file on this page" }));
    await user.click(screen.getByRole("button", { name: "Mark invalid" }));
    await screen.findByRole("heading", { name: "Mark 3 files as invalid" });
    await user.type(screen.getByRole("textbox"), REASON);
    await user.click(screen.getByRole("button", { name: "Flag 3 invalid" }));

    await waitFor(() => expect(writeCalls("/invalid-flag")).toHaveLength(3));
    for (const call of writeCalls("/invalid-flag")) {
      expect(JSON.parse(call.body as string)).toMatchObject({
        reason: REASON,
        actor: PORTAL_NAME,
      });
    }
  });

  it("refuses to write when the reason is blank, because the route needs one", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await awaitIdentity();
    await pick(user, "alpha");
    await user.click(screen.getByRole("button", { name: "Mark invalid" }));
    await screen.findByRole("heading", { name: "Mark 1 file as invalid" });
    await user.click(screen.getByRole("button", { name: "Flag 1 invalid" }));

    expect(await screen.findByText("A reason is required.")).toBeInTheDocument();
    expect(writeCalls("/invalid-flag")).toHaveLength(0);
  });

  it("clears the selection and refreshes the list when every call succeeds", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await awaitIdentity();
    const listsBefore = calls.filter((call) => call.url === "/api/proxy/files").length;
    await pick(user, "alpha");
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("heading", { name: "Archive 1 file" });
    await user.click(screen.getByRole("button", { name: "Archive 1" }));

    await waitFor(() => expect(writeCalls("/archive")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("region", { name: /Batch actions/ })).toBeNull());
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/api/proxy/files").length).toBeGreaterThan(
        listsBefore,
      ),
    );
  });
});

describe("a partial failure never reads as a success", () => {
  it("finishes the rest, states both counts and names the file it could not write", async () => {
    refuse = { bravo: { status: 409, code: "already_flagged" } };
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await awaitIdentity();
    await user.click(screen.getByRole("checkbox", { name: "Select every file on this page" }));
    await user.click(screen.getByRole("button", { name: "Mark invalid" }));
    await screen.findByRole("heading", { name: "Mark 3 files as invalid" });
    await user.type(screen.getByRole("textbox"), REASON);
    await user.click(screen.getByRole("button", { name: "Flag 3 invalid" }));

    // The refusal never stops the loop: all three files took a call.
    await waitFor(() => expect(writeCalls("/invalid-flag")).toHaveLength(3));

    const report = await screen.findByRole("alert");
    expect(report).toHaveTextContent("2 of 3 succeeded. 1 failed.");
    expect(within(report).getByText("bravo.mf4")).toBeInTheDocument();
    expect(report).toHaveTextContent("It already carries the invalid mark.");
    // The dialog stays open, so the report cannot be missed.
    expect(screen.getByRole("heading", { name: "Mark 3 files as invalid" })).toBeInTheDocument();
  });

  it("keeps the refused file picked, and drops the ones that went through", async () => {
    refuse = { charlie: { status: 409, code: "file_deleted" } };
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await awaitIdentity();
    await user.click(screen.getByRole("checkbox", { name: "Select every file on this page" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("heading", { name: "Archive 3 files" });
    await user.click(screen.getByRole("button", { name: "Archive 3" }));

    await waitFor(() => expect(writeCalls("/archive")).toHaveLength(3));
    await screen.findByText(/1 failed\./);
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(await screen.findByRole("region", { name: /Batch actions/ })).toHaveTextContent(
      "1 file picked.",
    );
  });

  it("reports every file when the whole batch fails", async () => {
    refuse = {
      alpha: { status: 404, code: "file_not_found" },
      bravo: { status: 404, code: "file_not_found" },
    };
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await awaitIdentity();
    await pick(user, "alpha");
    await pick(user, "bravo");
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("heading", { name: "Archive 2 files" });
    await user.click(screen.getByRole("button", { name: "Archive 2" }));

    const report = await screen.findByRole("alert");
    expect(report).toHaveTextContent("0 of 2 succeeded. 2 failed.");
  });
});

/** Every download the app asked for, in order. */
function downloadCalls() {
  return calls.filter((call) => call.method === "GET" && call.url.endsWith("/download"));
}

describe("the batch download loops the audited single-file route", () => {
  it("downloads each picked file, one call at a time, and writes nothing", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await pick(user, "alpha");
    await pick(user, "charlie");
    await user.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(downloadCalls()).toHaveLength(2));
    expect(downloadCalls().map((call) => call.url)).toEqual([
      "/api/proxy/files/alpha/download",
      "/api/proxy/files/charlie/download",
    ]);
    // The unpicked row never takes a call, and the loop never races itself.
    expect(calls.some((call) => call.url.includes("/bravo/"))).toBe(false);
    expect(peakInFlight).toBe(1);
    // A download is a read. The audit row is the ROUTE's job, before the bytes.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    // A clean sweep shows no report, and the picks survive — nothing moved.
    await waitFor(() =>
      expect(screen.getByRole("region", { name: /Batch actions/ })).toHaveTextContent(
        "2 files picked.",
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("skips a quarantined row without a call, and says so by name", async () => {
    stubFetch([
      fileRow("alpha"),
      fileRow("bravo", { status: "quarantined", quarantine_reason: "no run key" }),
      fileRow("charlie"),
    ]);
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await user.click(screen.getByRole("checkbox", { name: "Select every file on this page" }));
    await user.click(screen.getByRole("button", { name: "Download" }));

    const report = await screen.findByRole("alert");
    expect(report).toHaveTextContent("Downloaded 2 of 3 picked files. 1 skipped.");
    expect(within(report).getByText("bravo.mf4")).toBeInTheDocument();
    expect(report).toHaveTextContent("It is quarantined. The registry refuses its download.");
    // The skip took no call, so the route wrote no journal row for it.
    expect(downloadCalls().map((call) => call.url)).toEqual([
      "/api/proxy/files/alpha/download",
      "/api/proxy/files/charlie/download",
    ]);
  });

  it("reads a 403 from a stale row as a skip, with the quarantine rule spelled out", async () => {
    refuse = { bravo: { status: 403, code: "not_allowed" } };
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await user.click(screen.getByRole("checkbox", { name: "Select every file on this page" }));
    await user.click(screen.getByRole("button", { name: "Download" }));

    const report = await screen.findByRole("alert");
    expect(report).toHaveTextContent("Downloaded 2 of 3 picked files. 1 skipped.");
    expect(report).toHaveTextContent("It is quarantined. The registry refuses its download.");
    // The route was asked — the row lied — and the refusal stopped nothing else.
    expect(downloadCalls()).toHaveLength(3);
  });

  it("reports a failed file honestly, and never claims it downloaded", async () => {
    refuse = { bravo: { status: 503, code: "storage_unreachable" } };
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await user.click(screen.getByRole("checkbox", { name: "Select every file on this page" }));
    await user.click(screen.getByRole("button", { name: "Download" }));

    const report = await screen.findByRole("alert");
    expect(report).toHaveTextContent("Downloaded 2 of 3 picked files. 1 failed.");
    expect(within(report).getByText("bravo.mf4")).toBeInTheDocument();
    expect(report).toHaveTextContent(
      "Storage unreachable — download is available in the deployed environment.",
    );
  });

  it("stops between files on cancel, and counts what never started", async () => {
    let release!: () => void;
    downloadHold = new Promise((resolve) => {
      release = resolve;
    });
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await user.click(screen.getByRole("checkbox", { name: "Select every file on this page" }));
    await user.click(screen.getByRole("button", { name: "Download" }));

    // The first file is in flight. It finishes — its audit row is already
    // written — and the cancel stops the batch before the second call.
    await screen.findByText(/Downloading 1 of 3/);
    await user.click(screen.getByRole("button", { name: "Cancel download" }));
    release();

    const report = await screen.findByRole("alert");
    expect(report).toHaveTextContent("Downloaded 1 of 3 picked files. 2 never started.");
    expect(report).toHaveTextContent("2 files never started — you cancelled the batch.");
    expect(downloadCalls()).toHaveLength(1);
  });
});

describe("a hidden pick can never take a write", () => {
  it("drops the selection when a person changes the filters", async () => {
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await pick(user, "alpha");
    await screen.findByRole("region", { name: /Batch actions/ });

    await user.click(screen.getByRole("button", { name: /^Quarantined/ }));

    expect(nav.pushes).toContain("/files?status=quarantined");
    await waitFor(() => expect(screen.queryByRole("region", { name: /Batch actions/ })).toBeNull());
  });

  it("drops the selection when a person clears the filters again", async () => {
    nav.search = "status=quarantined";
    const user = userEvent.setup();
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("alpha.mf4");
    await pick(user, "bravo");
    await screen.findByRole("region", { name: /Batch actions/ });

    await user.click(screen.getByRole("button", { name: /^All/ }));

    await waitFor(() => expect(screen.queryByRole("region", { name: /Batch actions/ })).toBeNull());
  });
});
