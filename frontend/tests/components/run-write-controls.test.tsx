/**
 * The write controls on the run detail screen.
 *
 * Each test drives the real path: the screen or the dialog, the hook, the API
 * client and `fetch`. Only `fetch` is a stub, so the request the browser sends
 * is the thing under test. The routes are
 * `api/api/routers/test_runs.py` (PATCH and the two invalid-flag routes) and
 * `api/api/routers/journal.py` (the note).
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { EditRunDialog } from "@/components/screens/run-detail/edit-run-dialog";
import { InvalidFlagDialog } from "@/components/screens/run-detail/invalid-flag-dialog";
import { RunNoteDialog } from "@/components/screens/run-detail/run-note-dialog";
import { RunDetailScreen } from "@/components/screens/run-detail/run-detail-screen";
import { setActivePortalToken } from "@/lib/portal/token-store";
import type { TestRun } from "@/types";
import { setPortalApiBase } from "@/lib/portal/client";

// The screen reads the active tab from the URL (`?tab=…`) via next/navigation;
// none of these tests leave the default (signals) tab.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/runs/${RUN_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

// Each test drives a real dialog through user-event, so it takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const RUN_ID = "TAS-88214";
const PORTAL_API = "https://portal-api.dev.quix.io";
/** The name the Portal profile resolves to. Every write must carry it. */
const PORTAL_NAME = "Erika Lindqvist";
/** The literal `lib/api/client.ts` held before the Portal identity landed. */
const OLD_LITERAL = "e.lindqvist";

const savedEnv = { ...process.env };

/** Every request the app sent, in order. */
let calls: Array<{ url: string; init: RequestInit }> = [];
/** The answer the write route gives next. */
let writeAnswer: () => Response = () => json(run());
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

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    run_id: RUN_ID,
    description: "E-machine efficiency map",
    definition_id: "TD-4471",
    work_order_id: "WO-2026-0851",
    project: "EM-2026",
    rig_id: "RIG-04",
    test_cell: "C2",
    file_count: 3,
    signal_count: 186,
    first_data_at: "2026-08-14T10:02:00Z",
    status: "complete",
    invalid: { flagged: false, reason: null, actor: null, at: null },
    operator: null,
    bench_sw: "TAS 7.4.2",
    started_at: "2026-08-14T09:00:00Z",
    ended_at: "2026-08-14T11:00:00Z",
    result_count: 0,
    journal_count: 3,
    field_sources: {},
    created_at: "2026-08-14T10:02:00Z",
    updated_at: "2026-08-14T10:02:00Z",
    custom_properties: {},
    ...overrides,
  } as TestRun;
}

const FLAGGED = run({
  status: "invalid",
  invalid: {
    flagged: true,
    reason: "Coolant flow sensor drifted after cycle 14",
    actor: PORTAL_NAME,
    at: "2026-08-14T12:00:00Z",
  },
});

function emptyPage() {
  return { items: [], total: 0, page: 1, page_size: 50, total_pages: 0 };
}

/** The mirrored work orders the link picker offers. */
const WORK_ORDERS = [
  {
    wo_id: "WO-2026-0847",
    title: "E-machine efficiency characterisation",
    project: "EX90",
    status: "active",
    definition_count: 2,
    run_count: 2,
    synced_at: "2026-08-14T11:32:04Z",
  },
  {
    wo_id: "WO-2026-0843",
    title: "Inverter derating sweep",
    project: "EX90",
    status: "active",
    definition_count: 1,
    run_count: 1,
    synced_at: "2026-08-14T11:32:04Z",
  },
];

/** The answer `GET /work-orders` gives next. */
let workOrderPage: () => Response = () =>
  json({ items: WORK_ORDERS, total: 2, page: 1, page_size: 200, total_pages: 1 });

function stubFetch(runBody: TestRun): void {
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
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/invalid-flag`) return writeAnswer();
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/journal`) {
        if (method === "POST") return writeAnswer();
        return json(emptyPage());
      }
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}`) {
        if (method === "PATCH") return writeAnswer();
        return json(runBody);
      }
      if (url.pathname === "/api/proxy/work-orders") return workOrderPage();
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/signals`) return json(emptyPage());
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/files`) return json({ items: [] });
      if (url.pathname === "/api/proxy/results") return json(emptyPage());
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

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  profile = {
    userId: "u-1",
    email: "e.lindqvist@volvo.com",
    firstName: "Erika",
    lastName: "Lindqvist",
  };
  writeAnswer = () => json(run());
  workOrderPage = () =>
    json({ items: WORK_ORDERS, total: 2, page: 1, page_size: 200, total_pages: 1 });
  stubFetch(run());
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe("the unflag control reaches DELETE /test-runs/{run_id}/invalid-flag", () => {
  it("sends DELETE with the reason and the Portal identity", async () => {
    const user = userEvent.setup();
    render(<InvalidFlagDialog runId={RUN_ID} mode="clear" open onOpenChange={() => {}} />, {
      wrapper: Wrapper,
    });
    await awaitIdentity();

    await user.type(
      screen.getByLabelText("Reason for clearing the flag"),
      "Sensor recalibrated and the data re-checked",
    );
    await user.click(screen.getByRole("button", { name: "Clear invalid flag" }));

    await waitFor(() => expect(writeCall("DELETE", "/invalid-flag")).toBeDefined());
    const body = bodyOf(writeCall("DELETE", "/invalid-flag"));
    expect(body).toEqual({
      reason: "Sensor recalibrated and the data re-checked",
      actor: PORTAL_NAME,
    });
  });

  it("puts a Clear invalid flag button on a flagged run, and no Mark invalid button", async () => {
    stubFetch(FLAGGED);
    render(<RunDetailScreen runId={RUN_ID} />, { wrapper: Wrapper });

    expect(await screen.findByRole("button", { name: "Clear invalid flag" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Mark invalid/ })).toBeNull();
  });

  it("opens the clear dialog from the banner button", async () => {
    stubFetch(FLAGGED);
    const user = userEvent.setup();
    render(<RunDetailScreen runId={RUN_ID} />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: "Clear invalid flag" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(`Clear the invalid flag on ${RUN_ID}`)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Reason for clearing the flag")).toBeInTheDocument();
  });

  it("still sends POST when the dialog raises a flag", async () => {
    const user = userEvent.setup();
    render(<InvalidFlagDialog runId={RUN_ID} mode="raise" open onOpenChange={() => {}} />, {
      wrapper: Wrapper,
    });
    await awaitIdentity();

    await user.type(screen.getByLabelText("Reason for flagging invalid"), "Rig vibration spike");
    await user.click(screen.getByRole("button", { name: "Flag invalid" }));

    await waitFor(() => expect(writeCall("POST", "/invalid-flag")).toBeDefined());
    expect(bodyOf(writeCall("POST", "/invalid-flag"))).toEqual({
      reason: "Rig vibration spike",
      actor: PORTAL_NAME,
    });
  });
});

describe("the metadata edit posts PATCH /test-runs/{run_id}", () => {
  it("sends only the fields a person changed, plus the actor", async () => {
    const user = userEvent.setup();
    render(<EditRunDialog run={run()} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    await user.type(screen.getByLabelText("Operator"), "S. Vidal");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(writeCall("PATCH", `/test-runs/${RUN_ID}`)).toBeDefined());
    expect(bodyOf(writeCall("PATCH", `/test-runs/${RUN_ID}`))).toEqual({
      operator: "S. Vidal",
      actor: PORTAL_NAME,
    });
  });

  it("sends no key the route refuses, because the model forbids extras", async () => {
    const user = userEvent.setup();
    render(<EditRunDialog run={run()} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    await user.type(screen.getByLabelText("Operator"), "S. Vidal");
    await user.type(screen.getByLabelText(/^Note/), "set from the shift roster");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(writeCall("PATCH", `/test-runs/${RUN_ID}`)).toBeDefined());
    const keys = Object.keys(bodyOf(writeCall("PATCH", `/test-runs/${RUN_ID}`)));
    // `_PATCHABLE_FIELDS` in `api/api/routers/test_runs.py`, plus actor and note.
    const allowed = [
      "description",
      "operator",
      "bench_sw",
      "work_order_id",
      "definition_id",
      "actor",
      "note",
    ];
    expect(keys.every((key) => allowed.includes(key))).toBe(true);
  });

  it("refuses to save when nothing changed, and sends no request", async () => {
    const user = userEvent.setup();
    render(<EditRunDialog run={run()} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((alert) => /Nothing changed yet/.test(alert.textContent ?? ""))).toBe(true);
    expect(calls.some((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH")).toBe(
      false,
    );
  });

  it("states a sentence a person can act on when the registry refuses", async () => {
    writeAnswer = () => apiError(400, "no_fields_to_update");
    const user = userEvent.setup();
    render(<EditRunDialog run={run()} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    await user.type(screen.getByLabelText("Operator"), "S. Vidal");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(
        alerts.some((alert) => /Edit a field and save again/.test(alert.textContent ?? "")),
      ).toBe(true);
    });
    // The dialog stays open, so the person reads the reason and retries.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});

describe("the metadata edit links a run to a mirrored work order", () => {
  /** A run planning never linked. This is the run a person repairs. */
  const UNLINKED = run({ work_order_id: null, project: null, status: "awaiting_work_order" });

  it("offers a labeled combobox over the mirrored work orders, never selection-free text", async () => {
    const user = userEvent.setup();
    render(<EditRunDialog run={UNLINKED} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    const picker = await screen.findByLabelText("Work order");
    expect(picker).toHaveRole("combobox");
    await user.click(picker);
    // Only mirrored work orders are offered. The route cannot unlink a run,
    // so no option clears the link — an empty box means "keep the current".
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "WO-2026-0847 · E-machine efficiency characterisation",
      "WO-2026-0843 · Inverter derating sweep",
    ]);
  });

  it("sends the typed text as a debounced ?q= to the mirror, so no work order is out of reach", async () => {
    const user = userEvent.setup();
    render(<EditRunDialog run={UNLINKED} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    const picker = await screen.findByLabelText("Work order");
    await user.type(picker, "derating");

    await waitFor(() => {
      const searched = calls.find(
        (entry) =>
          entry.url.includes("/api/proxy/work-orders") && entry.url.includes("q=derating"),
      );
      expect(searched, "the picker never sent ?q=derating to /work-orders").toBeDefined();
    });
  });

  it("sends work_order_id and the actor, and never a project key", async () => {
    const user = userEvent.setup();
    render(<EditRunDialog run={UNLINKED} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    const picker = await screen.findByLabelText("Work order");
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /WO-2026-0847/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(writeCall("PATCH", `/test-runs/${RUN_ID}`)).toBeDefined());
    expect(bodyOf(writeCall("PATCH", `/test-runs/${RUN_ID}`))).toEqual({
      work_order_id: "WO-2026-0847",
      actor: PORTAL_NAME,
    });
  });

  it("sends nothing when the person leaves the picker alone", async () => {
    const user = userEvent.setup();
    render(<EditRunDialog run={UNLINKED} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    await screen.findByLabelText("Work order");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((alert) => /Nothing changed yet/.test(alert.textContent ?? ""))).toBe(true);
    expect(calls.some((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH")).toBe(
      false,
    );
  });

  it("states a sentence a person can act on when the route answers 422 unknown_work_order", async () => {
    writeAnswer = () => apiError(422, "unknown_work_order");
    const user = userEvent.setup();
    render(<EditRunDialog run={UNLINKED} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    const picker = await screen.findByLabelText("Work order");
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /WO-2026-0847/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(
        alerts.some((alert) => /Reopen this dialog and pick again/.test(alert.textContent ?? "")),
      ).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("says the link cannot change when the work order list never arrives", async () => {
    workOrderPage = () => apiError(503, "unavailable");
    render(<EditRunDialog run={UNLINKED} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    expect(await screen.findByText(/no link can change/)).toBeInTheDocument();
  });

  it("offers no definition picker, because no definition list reaches the front end", async () => {
    render(<EditRunDialog run={UNLINKED} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    await screen.findByLabelText("Work order");
    expect(screen.queryByLabelText(/definition/i)).toBeNull();
    expect(screen.queryByLabelText(/^Project/)).toBeNull();
    expect(screen.queryByLabelText(/test cell/i)).toBeNull();
  });
});

describe("the note control posts POST /test-runs/{run_id}/journal", () => {
  it("sends the note text and the Portal identity, and nothing else", async () => {
    const user = userEvent.setup();
    render(<RunNoteDialog runId={RUN_ID} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    await user.type(screen.getByLabelText("Note text"), "Coolant topped up between cycles");
    await user.click(screen.getByRole("button", { name: "Add note" }));

    await waitFor(() => expect(writeCall("POST", "/journal")).toBeDefined());
    expect(bodyOf(writeCall("POST", "/journal"))).toEqual({
      note: "Coolant topped up between cycles",
      actor: PORTAL_NAME,
    });
  });

  it("states a sentence a person can act on when the registry refuses", async () => {
    writeAnswer = () => apiError(404, "run_not_found");
    const user = userEvent.setup();
    render(<RunNoteDialog runId={RUN_ID} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    await user.type(screen.getByLabelText("Note text"), "Coolant topped up");
    await user.click(screen.getByRole("button", { name: "Add note" }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((alert) => /Reload the screen/.test(alert.textContent ?? ""))).toBe(true);
    });
  });
});

describe("every write carries the Portal identity and never a literal", () => {
  it("never sends the old DEMO_ACTOR literal on any write", async () => {
    const user = userEvent.setup();
    render(<EditRunDialog run={run()} open onOpenChange={() => {}} />, { wrapper: Wrapper });
    await awaitIdentity();

    await user.type(screen.getByLabelText("Operator"), "S. Vidal");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(writeCall("PATCH", `/test-runs/${RUN_ID}`)).toBeDefined());
    const body = bodyOf(writeCall("PATCH", `/test-runs/${RUN_ID}`));
    expect(body.actor).toBe(PORTAL_NAME);
    expect(body.actor).not.toBe(OLD_LITERAL);
  });

  it("takes the placeholder name 'Quix user' as no identity at all", async () => {
    // `lib/portal/client.ts` answers this name when the profile carries no
    // name and no email. `api/api/provenance.py` refuses it, so no write may
    // send it.
    profile = { userId: "u-2" };
    render(<RunNoteDialog runId={RUN_ID} open onOpenChange={() => {}} />, { wrapper: Wrapper });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/needs a signed-in Quix identity/);
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
  });

  it.each([
    ["the note dialog", "Add note", () => <RunNoteDialog runId={RUN_ID} open onOpenChange={() => {}} />],
    [
      "the metadata dialog",
      "Save changes",
      () => <EditRunDialog run={run()} open onOpenChange={() => {}} />,
    ],
    [
      "the unflag dialog",
      "Clear invalid flag",
      () => <InvalidFlagDialog runId={RUN_ID} mode="clear" open onOpenChange={() => {}} />,
    ],
  ])("%s refuses to submit while no identity resolves", async (_label, button, element) => {
    window.localStorage.clear();
    render(element(), { wrapper: Wrapper });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/needs a signed-in Quix identity/);
    expect(screen.getByRole("button", { name: button })).toBeDisabled();
    expect(calls.some((entry) => entry.url.includes("/api/proxy/test-runs"))).toBe(false);
  });
});
