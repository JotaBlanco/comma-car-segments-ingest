/**
 * The shared Add-a-note dialog (`components/shared/add-note-dialog.tsx`).
 *
 * Two routes serve one dialog: a run note posts to its own
 * `POST /test-runs/{run_id}/journal`, and every other entity posts through
 * the generic `POST /journal`. The generic route takes events only
 * (`JournalEventRequest` in `api/api/models/journal.py`), so the test pins
 * the wire shape: `kind: "event"`, a non-empty `field`, the `manual` source
 * and an `at` stamp — a drift here is a silent 422 in the app.
 *
 * The in-app mock BFF has no generic `/journal` POST yet, so the test stubs
 * at the fetch level on purpose.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AddNoteDialog } from "@/components/shared/add-note-dialog";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";

vi.setConfig({ testTimeout: 30_000 });

const FILE_ID = "f-9a41c2d0";
const RUN_ID = "TAS-88214";
const PORTAL_API = "https://portal-api.dev.quix.io";
const PORTAL_NAME = "Erika Lindqvist";

let calls: Array<{ url: string; init: RequestInit }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
      if (url.pathname === "/api/proxy/journal") return json({ id: "j-1" }, 201);
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/journal`) return json({ id: "j-2" }, 201);
      throw new TypeError(`no stub for ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function postCall(fragment: string): { url: string; init: RequestInit } {
  const call = calls.find(
    (entry) =>
      entry.url.includes(fragment) && (entry.init.method ?? "GET").toUpperCase() === "POST",
  );
  if (call === undefined) throw new Error(`the app sent no POST to ${fragment}`);
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
  stubFetch();
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the shared Add-a-note dialog", () => {
  it("posts a file note through the generic /journal route with the event wire shape", async () => {
    const user = userEvent.setup();
    render(
      <AddNoteDialog entityType="file" entityId={FILE_ID} open onOpenChange={() => {}} />,
      { wrapper: Wrapper },
    );
    await screen.findByText(PORTAL_NAME);

    await user.type(screen.getByLabelText("Note text"), "Checked against the rig log");
    await user.click(screen.getByRole("button", { name: "Add note" }));

    await waitFor(() => expect(postCall("/api/proxy/journal")).toBeDefined());
    const body = bodyOf(postCall("/api/proxy/journal"));
    expect(body).toMatchObject({
      entity_type: "file",
      entity_id: FILE_ID,
      field: "note",
      kind: "event",
      source: "manual",
      note: "Checked against the rig log",
      actor: PORTAL_NAME,
    });
    // The route requires `at`; the server stamps `received_at` beside it.
    expect(typeof body.at).toBe("string");
    expect(Number.isNaN(Date.parse(body.at as string))).toBe(false);
  });

  it("keeps the run on its own note route, never the generic one", async () => {
    const user = userEvent.setup();
    render(
      <AddNoteDialog entityType="run" entityId={RUN_ID} open onOpenChange={() => {}} />,
      { wrapper: Wrapper },
    );
    await screen.findByText(PORTAL_NAME);

    await user.type(screen.getByLabelText("Note text"), "Coolant top-up between cycle 8 and 9");
    await user.click(screen.getByRole("button", { name: "Add note" }));

    await waitFor(() => expect(postCall(`/test-runs/${RUN_ID}/journal`)).toBeDefined());
    expect(bodyOf(postCall(`/test-runs/${RUN_ID}/journal`))).toEqual({
      note: "Coolant top-up between cycle 8 and 9",
      actor: PORTAL_NAME,
    });
    expect(calls.some((entry) => entry.url === "/api/proxy/journal")).toBe(false);
  });

  it("refuses an empty note and sends nothing", async () => {
    const user = userEvent.setup();
    render(
      <AddNoteDialog entityType="signal" entityId="HV_Batt_Cell_Temp_Max" open onOpenChange={() => {}} />,
      { wrapper: Wrapper },
    );
    await screen.findByText(PORTAL_NAME);

    await user.click(screen.getByRole("button", { name: "Add note" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((alert) => /A note needs some text\./.test(alert.textContent ?? ""))).toBe(
      true,
    );
    expect(calls.some((entry) => (entry.init.method ?? "GET").toUpperCase() === "POST")).toBe(
      false,
    );
  });
});
