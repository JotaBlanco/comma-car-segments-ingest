/**
 * The catalog edit control on the signal detail screen.
 *
 * The test drives the real path: the dialog, the hook, the API client and
 * `fetch`. The route is `PATCH /signals/{name}`
 * (`api/api/routers/signals.py`), which accepts `unit`, `description` and
 * `sensor_ref` and refuses every other key.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { EditSignalDialog } from "@/components/screens/signals/edit-signal-dialog";
import { setActivePortalToken } from "@/lib/portal/token-store";
import type { SignalDetail } from "@/types";
import { setPortalApiBase } from "@/lib/portal/client";

vi.setConfig({ testTimeout: 30_000 });

const SIGNAL_NAME = "EM_Shaft_Torque";
const PORTAL_API = "https://portal-api.dev.quix.io";
const PORTAL_NAME = "Erika Lindqvist";
/** The literal `lib/api/client.ts` held before the Portal identity landed. */
const OLD_LITERAL = "e.lindqvist";

const savedEnv = { ...process.env };

let calls: Array<{ url: string; init: RequestInit }> = [];
let writeAnswer: () => Response = () => json(signal());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(status: number, code: string): Response {
  return json({ detail: `refused: ${code}`, code, errors: [] }, status);
}

function signal(): SignalDetail {
  return {
    name: SIGNAL_NAME,
    description: null,
    unit: null,
    unit_source: null,
    dtype: "float64",
    typical_rate_hz: 100,
    run_count: 4,
    first_seen: "2026-08-01T08:00:00Z",
    last_seen: "2026-08-14T11:00:00Z",
    sensor_ref: null,
    catalogue_ref: null,
    rig_ids: ["RIG-04"],
    field_sources: {},
  };
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
      // The unit autocomplete reads the whole catalog's units (§14b).
      if (url.pathname === "/api/proxy/signals/facets") {
        return json({ units: ["A", "V", "°C"], rates: [], rigs: [] });
      }
      if (url.pathname === `/api/proxy/signals/${SIGNAL_NAME}`) return writeAnswer();
      throw new TypeError(`no stub for ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function patchCall(): { url: string; init: RequestInit } {
  const call = calls.find(
    (entry) =>
      entry.url.includes("/signals/") && (entry.init.method ?? "GET").toUpperCase() === "PATCH",
  );
  if (call === undefined) throw new Error("the app sent no PATCH to the signal route");
  return call;
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

function renderDialog() {
  return render(<EditSignalDialog signal={signal()} open onOpenChange={() => {}} />, {
    wrapper: Wrapper,
  });
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  writeAnswer = () => json(signal());
  stubFetch();
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe("the catalog edit posts PATCH /signals/{name}", () => {
  it("sends only the fields a person changed, plus the Portal identity", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(PORTAL_NAME);

    await user.type(screen.getByLabelText("Unit"), "Nm");
    await user.type(screen.getByLabelText("Sensor ref"), "RIG-04-TC-17");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchCall()).toBeDefined());
    expect(bodyOf(patchCall())).toEqual({
      unit: "Nm",
      sensor_ref: "RIG-04-TC-17",
      actor: PORTAL_NAME,
    });
  });

  it("offers no field the route refuses", async () => {
    renderDialog();
    await screen.findByText(PORTAL_NAME);

    expect(screen.getByLabelText("Unit")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText("Sensor ref")).toBeInTheDocument();
    // `catalogue_ref` is catalog-owned, so the form never offers it.
    expect(screen.queryByLabelText(/Catalog entry/)).toBeNull();
  });

  it("names the Portal identity as the actor, and never the old literal", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(PORTAL_NAME);

    await user.type(screen.getByLabelText("Unit"), "Nm");
    // Typing opened the unit-suggestion popup; Escape closes it and keeps
    // the typed text, so the Save button is reachable again.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchCall()).toBeDefined());
    const body = bodyOf(patchCall());
    expect(body.actor).toBe(PORTAL_NAME);
    expect(body.actor).not.toBe(OLD_LITERAL);
  });

  it("refuses to save while no identity resolves, and sends no request", async () => {
    window.localStorage.clear();
    renderDialog();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/needs a signed-in Quix identity/);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // The dialog may READ the catalog (the unit facets), but it must WRITE nothing.
    expect(
      calls.some((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH"),
    ).toBe(false);
  });

  it("states a sentence a person can act on when the catalog refuses", async () => {
    writeAnswer = () => apiError(404, "signal_not_found");
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(PORTAL_NAME);

    await user.type(screen.getByLabelText("Unit"), "Nm");
    // Escape closes the unit-suggestion popup and keeps the typed text.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((alert) => /Reload the screen/.test(alert.textContent ?? ""))).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});
