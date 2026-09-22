/**
 * The custom property editor in "Edit the metadata of <run id>", and the
 * read-only disclosure on the run detail screen.
 *
 * Each test drives the real path: the dialog, the hook, the API client and
 * `fetch`. Only `fetch` is a stub, so the request the browser sends is the
 * thing under test. The route is `api/api/routers/test_runs.py` (PATCH).
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { EditRunDialog } from "@/components/screens/run-detail/edit-run-dialog";
import { RunDetailScreen } from "@/components/screens/run-detail/run-detail-screen";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";
import type { TestRun } from "@/types";

// The screen reads the active tab from the URL; no test leaves the default.
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

/** Every request the app sent, in order. */
let calls: Array<{ url: string; init: RequestInit }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function emptyPage() {
  return { items: [], total: 0, page: 1, page_size: 50, total_pages: 0 };
}

function stubFetch(runBody: TestRun): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      calls.push({ url: input, init });
      if (url.pathname === "/profile") {
        return json({
          userId: "u-1",
          email: "e.lindqvist@volvo.com",
          firstName: "Erika",
          lastName: "Lindqvist",
        });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });
      const method = (init.method ?? "GET").toUpperCase();
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}`) {
        if (method === "PATCH") return json(runBody);
        return json(runBody);
      }
      if (url.pathname === "/api/proxy/work-orders") {
        return json({ items: [], total: 0, page: 1, page_size: 200, total_pages: 0 });
      }
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/journal`) return json(emptyPage());
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

/** The one PATCH the app sent to the run route. */
function patchBody(): Record<string, unknown> {
  const call = calls.find(
    (entry) =>
      entry.url.includes(`/test-runs/${RUN_ID}`) &&
      (entry.init.method ?? "GET").toUpperCase() === "PATCH",
  );
  if (call === undefined) throw new Error("the app sent no PATCH to the run route");
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

function patchCount(): number {
  return calls.filter((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH").length;
}

/** Wait until the dialog shows the resolved Portal name, so no write races it. */
async function awaitIdentity(): Promise<void> {
  await screen.findByText(PORTAL_NAME);
}

async function openDialog(properties: Record<string, string>) {
  const user = userEvent.setup();
  render(<EditRunDialog run={run({ custom_properties: properties })} open onOpenChange={() => {}} />, {
    wrapper: Wrapper,
  });
  await awaitIdentity();
  return user;
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  stubFetch(run());
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the editor shows what the run carries", () => {
  it("puts one labelled row per stored property", async () => {
    await openDialog({ coolant: "50/50", "rig serial": "R-9" });

    expect(screen.getByLabelText("Custom property 1 name")).toHaveValue("coolant");
    expect(screen.getByLabelText("Custom property 1 value")).toHaveValue("50/50");
    expect(screen.getByLabelText("Custom property 2 name")).toHaveValue("rig serial");
    expect(screen.getByLabelText("Custom property 2 value")).toHaveValue("R-9");
  });

  it("says so when the run carries none", async () => {
    await openDialog({});

    expect(screen.getByText("This run carries no custom property.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Custom property 1 name")).toBeNull();
  });

  it("names the property on its remove control", async () => {
    await openDialog({ coolant: "50/50" });

    expect(
      screen.getByRole("button", { name: "Remove the custom property coolant" }),
    ).toBeInTheDocument();
  });

  it("appends an empty row when Add property is pressed", async () => {
    const user = await openDialog({});

    await user.click(screen.getByRole("button", { name: "Add property" }));

    expect(screen.getByLabelText("Custom property 1 name")).toHaveValue("");
    expect(screen.getByLabelText("Custom property 1 value")).toHaveValue("");
  });
});

describe("the editor sends the whole map", () => {
  it("sends the added pair beside the stored ones", async () => {
    const user = await openDialog({ coolant: "50/50" });

    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.type(screen.getByLabelText("Custom property 2 name"), "rig serial");
    await user.type(screen.getByLabelText("Custom property 2 value"), "R-9");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody().custom_properties).toEqual({ coolant: "50/50", "rig serial": "R-9" });
    expect(patchBody().actor).toBe(PORTAL_NAME);
  });

  it("sends the map without the removed pair", async () => {
    const user = await openDialog({ coolant: "50/50", "rig serial": "R-9" });

    await user.click(screen.getByRole("button", { name: "Remove the custom property coolant" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody().custom_properties).toEqual({ "rig serial": "R-9" });
  });

  it("sends an empty object when every row goes", async () => {
    const user = await openDialog({ coolant: "50/50" });

    await user.click(screen.getByRole("button", { name: "Remove the custom property coolant" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody().custom_properties).toEqual({});
  });

  it("sends nothing about the map when no row changed", async () => {
    const user = await openDialog({ coolant: "50/50" });

    await user.type(screen.getByLabelText("Operator"), "A. Bergström");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody()).not.toHaveProperty("custom_properties");
  });
});

describe("the editor refuses a save it can name", () => {
  it("refuses an empty row and says why", async () => {
    const user = await openDialog({ coolant: "50/50" });

    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A custom property needs a name.",
    );
    expect(patchCount()).toBe(0);
  });

  it("refuses a row whose name is only spaces", async () => {
    const user = await openDialog({});

    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.type(screen.getByLabelText("Custom property 1 name"), "   ");
    await user.type(screen.getByLabelText("Custom property 1 value"), "R-9");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A custom property needs a name.",
    );
    expect(patchCount()).toBe(0);
  });

  it("refuses a repeated name and says which name repeats", async () => {
    const user = await openDialog({ coolant: "50/50" });

    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.type(screen.getByLabelText("Custom property 2 name"), "coolant");
    await user.type(screen.getByLabelText("Custom property 2 value"), "60/40");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      'Two custom properties are called "coolant"',
    );
    expect(patchCount()).toBe(0);
  });
});

describe("the dialog wording keeps the removal rule straight", () => {
  it("says a removed property is a change, not an emptied box", async () => {
    await openDialog({});

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("An emptied text box counts as no change.");
    expect(dialog).toHaveTextContent("A removed custom property is a change.");
  });
});

describe("the run detail screen shows the properties", () => {
  it("folds them behind a disclosure that counts them", async () => {
    stubFetch(run({ custom_properties: { coolant: "50/50", "rig serial": "R-9" } }));
    const user = userEvent.setup();
    render(<RunDetailScreen runId={RUN_ID} />, { wrapper: Wrapper });

    const summary = await screen.findByText("Custom properties (2)");
    await user.click(summary);

    const group = summary.closest("details") as HTMLElement;
    expect(within(group).getByText("coolant")).toBeInTheDocument();
    expect(within(group).getByText("50/50")).toBeInTheDocument();
    expect(within(group).getByText("rig serial")).toBeInTheDocument();
    expect(within(group).getByText("R-9")).toBeInTheDocument();
  });

  it("shows nothing at all when the run carries none", async () => {
    stubFetch(run({ custom_properties: {} }));
    render(<RunDetailScreen runId={RUN_ID} />, { wrapper: Wrapper });

    await screen.findByText("Metadata");
    expect(screen.queryByText(/Custom properties/)).toBeNull();
  });
});
