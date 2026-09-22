/**
 * The lifecycle, stage and version controls on the file detail screen.
 *
 * Each test drives the real path: the screen or the dialog, the hook, the API
 * client and `fetch`. Only `fetch` is a stub, so the request the browser sends
 * is the thing under test. The routes are `api/api/routers/files.py`:
 * `DELETE /files/{id}`, `POST /files/{id}/archive`, `POST /files/{id}/restore`,
 * `POST /files/{id}/versions` and `GET /files/{id}/versions`.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { FileDetailScreen } from "@/components/screens/files/file-detail-screen";
import { LifecycleDialog } from "@/components/screens/files/lifecycle-dialog";
import { UploadVersionDialog } from "@/components/screens/files/upload-version-dialog";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";
import type { FileDetail, FileEntity } from "@/types";

// The signals table on the file detail screen calls `useRouter`, and no app
// router mounts in a test, so the module answers a stub instead.
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

// Each test drives a real dialog through user-event, so it takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const FILE_ID = "f-11111111-1111-4111-8111-111111111111";
const V2_ID = "f-22222222-2222-4222-8222-222222222222";
const RUN_ID = "TAS-88214";
const PORTAL_API = "https://portal-api.dev.quix.io";
/** The name the Portal profile resolves to. Every write must carry it. */
const PORTAL_NAME = "Erika Lindqvist";

/** Every request the app sent, in order. */
let calls: Array<{ url: string; init: RequestInit }> = [];
/** The answer the lifecycle and version routes give next. */
let writeAnswer: () => Response = () => json(fileDetail());
/** The version chain `GET /files/{id}/versions` answers with. */
let versionItems: FileEntity[] = [];
/** The profile the Portal answers with. `null` means "no profile at all". */
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
    filename: "bat_cyc_20260814_0941.mf4",
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

function stubFetch(detail: FileDetail): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      calls.push({ url: input, init });
      if (url.pathname === "/profile") {
        return profile === null ? new Response(null, { status: 401 }) : json(profile);
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });
      const method = (init.method ?? "GET").toUpperCase();
      if (url.pathname === `/api/proxy/files/${FILE_ID}/versions`) {
        if (method === "POST") return writeAnswer();
        return json({ items: versionItems, total: versionItems.length });
      }
      if (url.pathname === `/api/proxy/files/${FILE_ID}/archive`) return writeAnswer();
      if (url.pathname === `/api/proxy/files/${FILE_ID}/restore`) return writeAnswer();
      if (url.pathname === `/api/proxy/files/${FILE_ID}`) {
        if (method === "DELETE") return writeAnswer();
        return json(detail);
      }
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
  await screen.findByText(PORTAL_NAME);
}

/**
 * Open the header's More-actions menu. The lifecycle controls moved off the
 * header row and into this menu, so every test opens it first.
 */
async function openMoreActions(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: "More actions" }));
  return await screen.findByRole("menu");
}

beforeEach(() => {
  // jsdom ships no WebCrypto `subtle`, and the version form hashes the picked
  // file with it. Node's own WebCrypto is the same algorithm a browser runs.
  vi.stubGlobal("crypto", webcrypto);
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  versionItems = [];
  profile = {
    userId: "u-1",
    email: "e.lindqvist@volvo.com",
    firstName: "Erika",
    lastName: "Lindqvist",
  };
  writeAnswer = () => json(fileDetail());
  stubFetch(fileDetail());
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the lifecycle badge stands beside the status badge, never instead of it", () => {
  it("shows both badges on an archived, quarantined file", async () => {
    stubFetch(
      fileDetail({
        lifecycle: "archived",
        status: "quarantined",
        quarantine_reason: "checksum mismatch",
      }),
    );
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByText("Quarantined")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });

  it("shows Active beside Registered on a plain file", async () => {
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByText("Registered")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });
});

describe("the More-actions menu offers the lifecycle control the state allows", () => {
  it("offers Archive and Delete on an active file, and no Restore", async () => {
    const user = userEvent.setup();
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    const menu = await openMoreActions(user);
    expect(within(menu).getByRole("menuitem", { name: "Archive" })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeEnabled();
    expect(within(menu).queryByRole("menuitem", { name: "Restore" })).toBeNull();
  });

  it("offers Restore and Delete on an archived file, and no Archive", async () => {
    const user = userEvent.setup();
    stubFetch(fileDetail({ lifecycle: "archived" }));
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    const menu = await openMoreActions(user);
    expect(within(menu).getByRole("menuitem", { name: "Restore" })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeEnabled();
    expect(within(menu).queryByRole("menuitem", { name: "Archive" })).toBeNull();
  });

  it("offers Restore only on a deleted file, and says the bytes stay", async () => {
    const user = userEvent.setup();
    stubFetch(fileDetail({ lifecycle: "deleted" }));
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByText(/keeps every byte/)).toBeInTheDocument();
    const menu = await openMoreActions(user);
    expect(within(menu).getByRole("menuitem", { name: "Restore" })).toBeEnabled();
    expect(within(menu).queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("opens the delete dialog from the menu, and never says permanently", async () => {
    const user = userEvent.setup();
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    const menu = await openMoreActions(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/soft delete/)).toBeInTheDocument();
    expect(within(dialog).getByText(/keeps every byte/)).toBeInTheDocument();
    expect(dialog.textContent ?? "").not.toMatch(/permanent/i);
  });
});

describe("the three lifecycle controls reach their routes", () => {
  it("sends DELETE /files/{id} with the note and the Portal identity", async () => {
    const user = userEvent.setup();
    render(
      <LifecycleDialog
        fileId={FILE_ID}
        filename="bat_cyc_20260814_0941.mf4"
        action="delete"
        open
        onOpenChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    await awaitIdentity();

    await user.type(screen.getByLabelText("Note (optional)"), "Superseded by the re-conversion");
    await user.click(screen.getByRole("button", { name: "Delete file" }));

    await waitFor(() => expect(writeCall("DELETE", `/files/${FILE_ID}`)).toBeDefined());
    expect(bodyOf(writeCall("DELETE", `/files/${FILE_ID}`))).toEqual({
      actor: PORTAL_NAME,
      note: "Superseded by the re-conversion",
    });
  });

  it("sends POST /files/{id}/archive with the actor and no note when none is typed", async () => {
    const user = userEvent.setup();
    render(
      <LifecycleDialog
        fileId={FILE_ID}
        filename="bat_cyc_20260814_0941.mf4"
        action="archive"
        open
        onOpenChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    await awaitIdentity();

    await user.click(screen.getByRole("button", { name: "Archive file" }));

    await waitFor(() => expect(writeCall("POST", "/archive")).toBeDefined());
    expect(bodyOf(writeCall("POST", "/archive"))).toEqual({ actor: PORTAL_NAME });
  });

  it("sends POST /files/{id}/restore with the actor", async () => {
    const user = userEvent.setup();
    render(
      <LifecycleDialog
        fileId={FILE_ID}
        filename="bat_cyc_20260814_0941.mf4"
        action="restore"
        open
        onOpenChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    await awaitIdentity();

    await user.click(screen.getByRole("button", { name: "Restore file" }));

    await waitFor(() => expect(writeCall("POST", "/restore")).toBeDefined());
    expect(bodyOf(writeCall("POST", "/restore"))).toEqual({ actor: PORTAL_NAME });
  });

  it("states a sentence a person can act on when archive answers 409 file_deleted", async () => {
    writeAnswer = () => apiError(409, "file_deleted");
    const user = userEvent.setup();
    render(
      <LifecycleDialog
        fileId={FILE_ID}
        filename="bat_cyc_20260814_0941.mf4"
        action="archive"
        open
        onOpenChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    await awaitIdentity();

    await user.click(screen.getByRole("button", { name: "Archive file" }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((alert) => /Restore it first/.test(alert.textContent ?? ""))).toBe(true);
    });
  });

  it("refuses to submit while no identity resolves, and sends no request", async () => {
    window.localStorage.clear();
    render(
      <LifecycleDialog
        fileId={FILE_ID}
        filename="bat_cyc_20260814_0941.mf4"
        action="delete"
        open
        onOpenChange={() => {}}
      />,
      { wrapper: Wrapper },
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/needs a signed-in Quix identity/);
    expect(screen.getByRole("button", { name: "Delete file" })).toBeDisabled();
    expect(calls.some((entry) => entry.url.includes("/api/proxy/files"))).toBe(false);
  });
});

describe("the version history reads GET /files/{id}/versions", () => {
  beforeEach(() => {
    versionItems = [
      fileRow({ version: 1, checksum_sha256: "a".repeat(64) }),
      fileRow({
        file_id: V2_ID,
        version: 2,
        checksum_sha256: "b".repeat(64),
        filename: "bat_cyc_20260814_0941_v2.mf4",
      }),
    ];
  });

  it("puts the newest version first, with its own id and its own checksum", async () => {
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("v2")).toBeInTheDocument();
    expect(rows[0].textContent).toContain(V2_ID);
    expect(rows[0].textContent).toContain("b".repeat(64));
    expect(within(rows[1]).getByText("v1")).toBeInTheDocument();
    expect(rows[1].textContent).toContain(FILE_ID);
    expect(rows[1].textContent).toContain("a".repeat(64));
  });

  it("gives every version its own download control", async () => {
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(
      await screen.findByRole("button", { name: "Download bat_cyc_20260814_0941_v2.mf4" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Download bat_cyc_20260814_0941.mf4" }),
    ).toBeEnabled();
  });

  it("says plainly that a new version overwrites no earlier one", async () => {
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByText(/never overwrites an earlier one/)).toBeInTheDocument();
  });
});

describe("the version control reaches POST /files/{id}/versions", () => {
  /** A picked file with known bytes, so the SHA-256 is a fixed value. */
  function pickedFile(): File {
    return new File(["new version bytes"], "bat_cyc_20260814_0941_v2.mf4", {
      type: "application/octet-stream",
    });
  }

  it("sends the filename, the size and the checksum the browser computed", async () => {
    writeAnswer = () => json(fileRow({ file_id: V2_ID, version: 2 }), 201);
    const user = userEvent.setup();
    render(
      <UploadVersionDialog file={fileDetail()} open onOpenChange={() => {}} />,
      { wrapper: Wrapper },
    );
    await awaitIdentity();

    await user.upload(screen.getByLabelText("New version of the file"), pickedFile());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Register version" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Register version" }));

    await waitFor(() => expect(writeCall("POST", "/versions")).toBeDefined());
    const body = bodyOf(writeCall("POST", "/versions"));
    // The digest of "new version bytes", computed the same way the form does.
    const expected = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode("new version bytes")),
    ).toString("hex");
    expect(body).toEqual({
      filename: "bat_cyc_20260814_0941_v2.mf4",
      source_system: "TAS",
      format: "MF4",
      size_bytes: 17,
      checksum_sha256: expected,
      actor: PORTAL_NAME,
    });
    // The route inherits the run of the newest version, so the form states none.
    expect(body.run_id).toBeUndefined();
  });

  it("sends the storage reference and the note when a person states them", async () => {
    writeAnswer = () => json(fileRow({ file_id: V2_ID, version: 2 }), 201);
    const user = userEvent.setup();
    render(
      <UploadVersionDialog file={fileDetail()} open onOpenChange={() => {}} />,
      { wrapper: Wrapper },
    );
    await awaitIdentity();

    await user.upload(screen.getByLabelText("New version of the file"), pickedFile());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Register version" })).toBeEnabled(),
    );
    await user.type(screen.getByLabelText(/Storage reference/), "tas-raw/2026/08/v2.mf4");
    await user.type(screen.getByLabelText(/^Note/), "Re-converted after the channel map fix");
    await user.click(screen.getByRole("button", { name: "Register version" }));

    await waitFor(() => expect(writeCall("POST", "/versions")).toBeDefined());
    const body = bodyOf(writeCall("POST", "/versions"));
    expect(body.storage_ref).toBe("tas-raw/2026/08/v2.mf4");
    expect(body.note).toBe("Re-converted after the channel map fix");
  });

  it("states a sentence a person can act on when the route answers 409", async () => {
    writeAnswer = () => apiError(409, "checksum_already_registered");
    const user = userEvent.setup();
    render(
      <UploadVersionDialog file={fileDetail()} open onOpenChange={() => {}} />,
      { wrapper: Wrapper },
    );
    await awaitIdentity();

    await user.upload(screen.getByLabelText("New version of the file"), pickedFile());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Register version" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Register version" }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(
        alerts.some((alert) => /already holds this checksum/.test(alert.textContent ?? "")),
      ).toBe(true);
    });
  });

  it("refuses the version while no identity resolves", async () => {
    window.localStorage.clear();
    render(
      <UploadVersionDialog file={fileDetail()} open onOpenChange={() => {}} />,
      { wrapper: Wrapper },
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/needs a signed-in Quix identity/);
    expect(screen.getByRole("button", { name: "Register version" })).toBeDisabled();
  });

  it("disables the Add a version control while the file is archived", async () => {
    stubFetch(fileDetail({ lifecycle: "archived" }));
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByRole("button", { name: "Add a version" })).toBeDisabled();
  });
});

describe("the three stage flags and the stage error show on the file detail screen", () => {
  it("shows one badge per stage", async () => {
    stubFetch(
      fileDetail({
        sync_status: "success",
        upload_status: "in_progress",
        conversion_status: "pending",
      }),
    );
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByText("Sync")).toBeInTheDocument();
    expect(screen.getByText("Upload")).toBeInTheDocument();
    expect(screen.getByText("Conversion")).toBeInTheDocument();
    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("shows the error text of a failed stage", async () => {
    stubFetch(
      fileDetail({
        sync_status: "success",
        upload_status: "success",
        conversion_status: "failed",
        stage_error: "MDF channel group 3 has no time channel",
      }),
    );
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(
      screen.getByText(/MDF channel group 3 has no time channel/),
    ).toBeInTheDocument();
  });

  it("reads an absent stage report as unknown, and never as failed", async () => {
    stubFetch(
      fileDetail({
        sync_status: null,
        upload_status: null,
        conversion_status: null,
        stage_error: null,
      }),
    );
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    expect(await screen.findByText(/the pipeline reported no stage yet/)).toBeInTheDocument();
    expect(screen.getAllByText("No report")).toHaveLength(3);
    expect(screen.queryByText("Failed")).toBeNull();
  });
});
