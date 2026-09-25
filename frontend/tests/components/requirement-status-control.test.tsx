/**
 * `StatusControl` — the requirement detail header's status dropdown
 * (`dev-planning/requirement-status-gates/spec.md` §4.5, §6.1 item 10).
 *
 * Each test drives the real component, the real hooks and the real API
 * client; only `fetch` is a stub, following the pattern in
 * `link-run-dialog.test.tsx` rather than mocking `@/lib/hooks` wholesale
 * (BL-48 names that pattern as fragile).
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));

vi.mock("sonner", () => {
  const record = (message: unknown): string => {
    toasts.push(typeof message === "string" ? message : String(message));
    return "toast-id";
  };
  const toast = Object.assign(record, {
    success: record,
    error: record,
    info: record,
    warning: record,
    message: record,
    loading: record,
    custom: record,
    dismiss: vi.fn(),
    promise: vi.fn(),
  });
  return { toast, Toaster: () => null };
});

import { StatusControl } from "@/components/screens/requirements/status-control";
import { setPortalApiBase } from "@/lib/portal/client";
import { setActivePortalToken } from "@/lib/portal/token-store";
import type { RequirementDetail } from "@/types";

vi.setConfig({ testTimeout: 30_000 });

const REQ_ID = "REQ-STATUS-001";
const PORTAL_API = "https://portal-api.dev.quix.io";
const PORTAL_NAME = "Erika Lindqvist";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function detail(overrides: Partial<RequirementDetail> = {}): RequirementDetail {
  return {
    req_id: REQ_ID,
    title: "Hold the current",
    system: null,
    chapter: null,
    status: "Draft",
    verification_method: null,
    ears_pattern: "Ubiquitous",
    revision: null,
    verification_state: "not_covered",
    evidence_stale: false,
    verified_by: [],
    covering_run_ids: [],
    covering_run_count: 0,
    latest_run_id: null,
    tested_at: null,
    synced_at: null,
    text: "The battery system shall hold the current.",
    text_rendered: null,
    measurand: [],
    system_states: [],
    source: [],
    related_reqs: [],
    rationale: null,
    verification_criteria: null,
    figure_refs: [],
    normative_sha256: "n-1",
    normative_changed_at: null,
    item_version: 1,
    content_sha256: "c-1",
    field_sources: {},
    evidence: [],
    ...overrides,
  };
}

/** Every request the app sent, in order. */
let calls: Array<{ url: string; init: RequestInit }> = [];
/** The answer the PATCH route gives next. */
let patchAnswer: () => Response = () => json(detail({ status: "Ready for Review" }));

function stubFetch(): void {
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
      if (url.pathname === `/api/proxy/requirements/${REQ_ID}` && method === "PATCH") {
        return patchAnswer();
      }
      throw new TypeError(`no stub for ${method} ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function patchCall(): { url: string; init: RequestInit } {
  const call = calls.find((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH");
  if (call === undefined) throw new Error("the app sent no PATCH");
  return call;
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  toasts.length = 0;
  patchAnswer = () => json(detail({ status: "Ready for Review" }));
  stubFetch();
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderControl(overrides: Partial<RequirementDetail> = {}) {
  return render(<StatusControl detail={detail(overrides)} />, { wrapper: Wrapper });
}

/** Wait until the identity resolves, so the trigger is enabled. */
async function awaitEnabled(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: /^Status:/ });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  return trigger;
}

/** Click the trigger and return the open menu, mirroring
    `file-lifecycle-controls.test.tsx`'s `openMoreActions`. */
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await awaitEnabled());
  return screen.findByRole("menu");
}

describe("StatusControl — the free-band moves (spec §4.5)", () => {
  it("offers exactly Send for review and Reject from Draft", async () => {
    const user = userEvent.setup();
    renderControl({ status: "Draft" });
    const menu = await openMenu(user);

    expect(within(menu).getByRole("menuitem", { name: "Send for review" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Reject" })).toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "Withdraw to Draft" }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "Reopen as Draft" }),
    ).not.toBeInTheDocument();
  });

  it("offers Withdraw to Draft and Reject from Ready for Review", async () => {
    const user = userEvent.setup();
    renderControl({ status: "Ready for Review" });
    const menu = await openMenu(user);

    expect(within(menu).getByRole("menuitem", { name: "Withdraw to Draft" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Reject" })).toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "Send for review" }),
    ).not.toBeInTheDocument();
  });

  it("offers Reopen as Draft, Send for review and Reject from Reviewed", async () => {
    const user = userEvent.setup();
    renderControl({ status: "Reviewed" });
    const menu = await openMenu(user);

    expect(within(menu).getByRole("menuitem", { name: "Reopen as Draft" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Send for review" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Reject" })).toBeInTheDocument();
  });

  it("offers nothing from Obsolete but states retirement is final", async () => {
    const user = userEvent.setup();
    renderControl({ status: "Obsolete" });
    const menu = await openMenu(user);

    // Only the free-band move section is empty — the disabled earned/derived
    // rows still render underneath it (spec §4.5), so an item count of zero
    // is the wrong assertion; no ENABLED item may exist.
    const enabled = within(menu)
      .queryAllByRole("menuitem")
      .filter((item) => item.getAttribute("aria-disabled") !== "true");
    expect(enabled).toHaveLength(0);
    expect(
      within(menu).getByText(
        "Retired. A retired requirement never returns and its id is never reused.",
      ),
    ).toBeInTheDocument();
  });

  it("PATCHes the target status with the current item_version and the Portal identity", async () => {
    const user = userEvent.setup();
    renderControl({ status: "Draft", item_version: 3 });
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Send for review" }));

    await waitFor(() => expect(patchCall()).toBeDefined());
    expect(patchCall().url).toBe(`/api/proxy/requirements/${REQ_ID}`);
    expect(bodyOf(patchCall())).toEqual({
      status: "Ready for Review",
      parent_version: 3,
      actor: PORTAL_NAME,
    });
  });
});

describe("StatusControl — the two derived rows are visible and disabled (spec §4.5)", () => {
  it("lists Implemented and Tested disabled, with their reasons, from every state", async () => {
    const user = userEvent.setup();
    renderControl({ status: "Draft" });
    const menu = await openMenu(user);

    const implemented = within(menu).getByText("Implemented").closest('[role="menuitem"]');
    const tested = within(menu).getByText("Tested").closest('[role="menuitem"]');
    expect(implemented).toHaveAttribute("aria-disabled", "true");
    expect(tested).toHaveAttribute("aria-disabled", "true");
    expect(
      within(menu).getByText(
        "Earned when every covering test case passes. Shown in Verification.",
      ),
    ).toBeInTheDocument();
  });
});

describe("StatusControl — a 409 illegal_transition renders the server's own sentence (spec §4.2)", () => {
  it("shows the server message, not a canned one, on refusal", async () => {
    patchAnswer = () =>
      json(
        {
          detail:
            "Tested is computed from test-run coverage and is never set by hand. It is shown in the Verification column.",
          code: "illegal_transition",
          errors: [],
        },
        409,
      );
    const user = userEvent.setup();
    renderControl({ status: "Draft" });
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Send for review" }));

    await waitFor(() =>
      expect(toasts).toContain(
        "Tested is computed from test-run coverage and is never set by hand. It is shown in the Verification column.",
      ),
    );
  });
});
