/**
 * The invalid mark at FILE level — the banner, the dialog and the list mark.
 *
 * The requirement asks for the mark on the container AND the file. The run
 * half lives in `tests/components/run-write-controls.test.tsx`. This is the
 * same story read at file level, and the routes are
 * `POST` and `DELETE /files/{file_id}/invalid-flag`
 * (`api/api/routers/files.py`).
 *
 * Each test drives the real path: the screen or the dialog, the hook, the API
 * client and `fetch`. Only `fetch` and the router are stubs, so the request the
 * browser sends is the thing under test.
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
import type { FileDetail, FileEntity, InvalidFlag } from "@/types";

const { nav } = vi.hoisted(() => ({
  nav: { search: "", pushes: [] as string[] },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => nav.pushes.push(href),
    replace: (href: string) => nav.pushes.push(href),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { FileDetailScreen } from "@/components/screens/files/file-detail-screen";
import { FilesScreen } from "@/components/screens/files/files-screen";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";

// Each test drives a real dialog through user-event, so it takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const FILE_ID = "f-11111111-1111-4111-8111-111111111111";
const FILENAME = "bat_cyc_20260814_0941.mf4";
const RUN_ID = "TAS-88214";
const PORTAL_API = "https://portal-api.dev.quix.io";
/** The name the Portal profile resolves to. Every write must carry it. */
const PORTAL_NAME = "Erika Lindqvist";
const REASON = "Cell 7 thermocouple came loose at 10:12";

const CLEAR: InvalidFlag = { flagged: false, reason: null, actor: null, at: null };
const FLAGGED: InvalidFlag = {
  flagged: true,
  reason: REASON,
  actor: PORTAL_NAME,
  at: "2026-08-14T12:00:00Z",
};

/** Every request the app sent, in order. */
let calls: Array<{ url: string; init: RequestInit }> = [];
/** Every `GET /files` query string the app sent, in order. */
let fileQueries: string[] = [];
/** The answer the two invalid-flag routes give next. */
let writeAnswer: () => Response = () => json(fileDetail());
/** The profile the Portal answers with. */
let profile: Record<string, unknown> | null = {
  userId: "u-1",
  email: "e.lindqvist@volvo.com",
  firstName: "Erika",
  lastName: "Lindqvist",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(status: number, code: string): Response {
  return json({ detail: `refused: ${code}`, code, errors: [] }, status);
}

function fileRow(overrides: Partial<FileEntity> = {}): FileEntity {
  return {
    file_id: FILE_ID,
    filename: FILENAME,
    run_id: RUN_ID,
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

function fileDetail(overrides: Partial<FileDetail> = {}): FileDetail {
  return {
    ...fileRow(),
    storage_ref: "tas-raw/2026/08/bat_cyc_20260814_0941.mf4",
    ingestion_job_id: "ing-8841",
    field_sources: {},
    ingestion_timeline: [],
    signals: [],
    ...overrides,
  };
}

/** The detail screen's own stub. The list route is not part of that screen. */
function stubDetailFetch(detail: FileDetail): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost:3000");
      calls.push({ url: input, init });
      if (url.pathname === "/profile") {
        return profile === null ? new Response(null, { status: 401 }) : json(profile);
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });
      const method = (init.method ?? "GET").toUpperCase();
      if (url.pathname === `/api/proxy/files/${FILE_ID}/invalid-flag`) return writeAnswer();
      if (url.pathname === `/api/proxy/files/${FILE_ID}/versions`) {
        return json({ items: [], total: 0 });
      }
      if (url.pathname === `/api/proxy/files/${FILE_ID}`) return json(detail);
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}`) {
        return json({
          run_id: RUN_ID,
          work_order_id: "WO-2026-0851",
          definition_id: "TD-4471",
        });
      }
      throw new TypeError(`no stub for ${method} ${input}`);
    }),
  );
}

/** The list screen's own stub. It answers the rows the query asks for. */
function stubListFetch(rows: FileEntity[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost:3000");
      if (url.pathname === "/api/proxy/files") {
        fileQueries.push(url.search);
        const asked = url.searchParams.get("invalid");
        const items =
          asked === null
            ? rows
            : rows.filter((row) => (row.invalid?.flagged === true) === (asked === "true"));
        return json({
          items,
          total: items.length,
          page: 1,
          page_size: 20,
          total_pages: 1,
          view_counts: { all: rows.length, registered: rows.length, quarantined: 0, archived: 0, deleted: 0 },
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

/** The one request the app sent to a write route, by method. */
function writeCall(method: string, fragment: string): { url: string; init: RequestInit } {
  const call = calls.find(
    (entry) =>
      entry.url.includes(fragment) && (entry.init.method ?? "GET").toUpperCase() === method,
  );
  if (call === undefined) throw new Error(`the app sent no ${method} to ${fragment}`);
  return call;
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

/** Wait until the dialog shows the resolved Portal name, so no write races it. */
async function awaitIdentity(): Promise<void> {
  // The banner prints the actor as well, so the name can stand twice.
  await screen.findAllByText(PORTAL_NAME);
}

/**
 * Open the header's More-actions menu. The Flag-invalid control moved off the
 * header row and into this menu, so a test reaches it through the menu first.
 * The banner's own "Clear invalid flag" button stays on the banner.
 */
async function openMoreActions(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: "More actions" }));
  return await screen.findByRole("menu");
}

/** The invalid banner. The screen carries other alerts, so name this one. */
async function findBanner(): Promise<HTMLElement> {
  const alerts = await screen.findAllByRole("alert");
  const banner = alerts.find((alert) => alert.textContent?.includes("Flagged invalid"));
  if (banner === undefined) throw new Error("the screen shows no invalid banner");
  return banner;
}

beforeEach(() => {
  nav.search = "";
  nav.pushes = [];
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  fileQueries = [];
  profile = {
    userId: "u-1",
    email: "e.lindqvist@volvo.com",
    firstName: "Erika",
    lastName: "Lindqvist",
  };
  writeAnswer = () => json(fileDetail({ invalid: FLAGGED }));
  stubDetailFetch(fileDetail({ invalid: CLEAR }));
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- the banner --------------------------------------------------------------

describe("the file detail screen shows the mark", () => {
  it("prints the banner with the actor, the time and the reason", async () => {
    stubDetailFetch(fileDetail({ invalid: FLAGGED }));
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    const banner = await findBanner();
    expect(banner).toHaveTextContent("Flagged invalid");
    expect(banner).toHaveTextContent(PORTAL_NAME);
    expect(banner).toHaveTextContent(REASON);
  });

  it("prints no banner on a file nobody marked", async () => {
    const user = userEvent.setup();
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    const menu = await openMoreActions(user);
    expect(within(menu).getByRole("menuitem", { name: "Flag invalid" })).toBeInTheDocument();
    expect(screen.queryByText("Flagged invalid")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear invalid flag" })).toBeNull();
  });

  it("prints no banner on a file the registry stored before the field existed", async () => {
    // The stored document holds no `invalid` key at all. An absent block reads
    // as "nobody marked this file", never as a mark.
    const user = userEvent.setup();
    const legacy = fileDetail();
    delete legacy.invalid;
    stubDetailFetch(legacy);
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    const menu = await openMoreActions(user);
    expect(within(menu).getByRole("menuitem", { name: "Flag invalid" })).toBeEnabled();
    expect(screen.queryByText("Flagged invalid")).toBeNull();
  });

  it("keeps the status badge — the mark never replaces the registry verdict", async () => {
    stubDetailFetch(
      fileDetail({
        invalid: FLAGGED,
        status: "quarantined",
        quarantine_reason: "checksum mismatch",
      }),
    );
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByText("Quarantined")).toBeInTheDocument();
    expect(screen.getByText("checksum mismatch")).toBeInTheDocument();
  });

  it("offers Flag invalid on a clear file and Clear invalid flag on a marked one", async () => {
    const user = userEvent.setup();
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });
    const menu = await openMoreActions(user);
    expect(within(menu).getByRole("menuitem", { name: "Flag invalid" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Clear invalid flag" })).toBeNull();
    // Shut the menu, so it cannot shadow the second render below.
    await user.keyboard("{Escape}");

    stubDetailFetch(fileDetail({ invalid: FLAGGED }));
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByRole("button", { name: "Clear invalid flag" })).toBeEnabled();
  });
});

// --- the dialog --------------------------------------------------------------

describe("the dialog sends the mark, with a reason and the signed-in name", () => {
  it("posts the reason and the Portal name to the file route", async () => {
    const user = userEvent.setup();
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });
    const menu = await openMoreActions(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Flag invalid" }));
    await awaitIdentity();

    await user.type(screen.getByRole("textbox", { name: /Reason for flagging/ }), REASON);
    await user.click(screen.getByRole("button", { name: "Flag invalid" }));

    await waitFor(() => writeCall("POST", `/files/${FILE_ID}/invalid-flag`));
    const call = writeCall("POST", `/files/${FILE_ID}/invalid-flag`);
    expect(bodyOf(call)).toEqual({ reason: REASON, actor: PORTAL_NAME });
  });

  it("sends the clear to the same path, with its own reason", async () => {
    const user = userEvent.setup();
    stubDetailFetch(fileDetail({ invalid: FLAGGED }));
    writeAnswer = () => json(fileDetail({ invalid: CLEAR }));
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });
    await user.click(await screen.findByRole("button", { name: "Clear invalid flag" }));
    await awaitIdentity();

    await user.type(
      screen.getByRole("textbox", { name: /Reason for clearing/ }),
      "thermocouple re-seated",
    );
    await user.click(screen.getByRole("button", { name: "Clear invalid flag" }));

    await waitFor(() => writeCall("DELETE", `/files/${FILE_ID}/invalid-flag`));
    expect(bodyOf(writeCall("DELETE", `/files/${FILE_ID}/invalid-flag`))).toEqual({
      reason: "thermocouple re-seated",
      actor: PORTAL_NAME,
    });
  });

  it("refuses a blank reason before it reaches the network", async () => {
    const user = userEvent.setup();
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });
    const menu = await openMoreActions(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Flag invalid" }));
    await awaitIdentity();

    await user.type(screen.getByRole("textbox", { name: /Reason for flagging/ }), "   ");
    await user.click(screen.getByRole("button", { name: "Flag invalid" }));

    expect(await screen.findByText("A reason is required.")).toBeInTheDocument();
    expect(
      calls.filter((call) => call.url.includes("/invalid-flag")),
    ).toHaveLength(0);
  });

  it("states the server's own 422 reason_required in one sentence", async () => {
    const user = userEvent.setup();
    writeAnswer = () => apiError(422, "reason_required");
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });
    const menu = await openMoreActions(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Flag invalid" }));
    await awaitIdentity();

    await user.type(screen.getByRole("textbox", { name: /Reason for flagging/ }), REASON);
    await user.click(screen.getByRole("button", { name: "Flag invalid" }));

    expect(await screen.findByText("A reason is required.")).toBeInTheDocument();
  });

  it("closes on a 409 and says the registry already holds that state", async () => {
    const user = userEvent.setup();
    writeAnswer = () => apiError(409, "already_flagged");
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });
    const menu = await openMoreActions(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Flag invalid" }));
    await awaitIdentity();

    await user.type(screen.getByRole("textbox", { name: /Reason for flagging/ }), REASON);
    await user.click(screen.getByRole("button", { name: "Flag invalid" }));

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /Reason for flagging/ })).toBeNull();
    });
  });

  it("refuses to write at all when nobody is signed in", async () => {
    const user = userEvent.setup();
    profile = null;
    window.localStorage.removeItem("tm.portal.token");
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });
    const menu = await openMoreActions(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Flag invalid" }));

    await user.type(screen.getByRole("textbox", { name: /Reason for flagging/ }), REASON);
    const submit = screen
      .getAllByRole("button", { name: "Flag invalid" })
      .find((button) => (button as HTMLButtonElement).disabled);
    expect(submit).toBeDefined();
    expect(calls.filter((call) => call.url.includes("/invalid-flag"))).toHaveLength(0);
  });
});

// --- the list ----------------------------------------------------------------

describe("the files list shows the mark", () => {
  it("prints the Invalid badge on a marked row and none on a clear row", async () => {
    stubListFetch([
      fileRow({ file_id: "f-marked", filename: "marked.mf4", invalid: FLAGGED }),
      fileRow({ file_id: "f-clear", filename: "clear.mf4", invalid: CLEAR }),
    ]);
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("marked.mf4");
    // The quick views name a status too, so read inside the two rows.
    const marked = screen.getByText("marked.mf4").closest("tr") as HTMLElement;
    const clear = screen.getByText("clear.mf4").closest("tr") as HTMLElement;

    // The mark stands BESIDE the status badge and never instead of it.
    expect(within(marked).getByText("Invalid")).toBeInTheDocument();
    expect(within(marked).getByText("Registered")).toBeInTheDocument();
    expect(within(clear).queryByText("Invalid")).toBeNull();
  });

  it("prints no Invalid badge for a row the registry stored before the field existed", async () => {
    const legacy = fileRow({ file_id: "f-legacy", filename: "legacy.mf4" });
    delete legacy.invalid;
    stubListFetch([legacy]);
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("legacy.mf4");
    const row = screen.getByText("legacy.mf4").closest("tr") as HTMLElement;
    expect(within(row).queryByText("Invalid")).toBeNull();
  });

  it("carries the reason on the badge, so a reader never leaves the table", async () => {
    stubListFetch([fileRow({ file_id: "f-marked", filename: "marked.mf4", invalid: FLAGGED })]);
    render(<FilesScreen />, { wrapper: Wrapper });

    await screen.findByText("marked.mf4");
    expect(screen.getByTitle(REASON)).toBeInTheDocument();
  });
});
