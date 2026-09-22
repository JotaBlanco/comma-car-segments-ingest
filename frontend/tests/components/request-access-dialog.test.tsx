/**
 * The Request-access dialog (`components/shared/request-access-dialog.tsx`).
 *
 * UC-003 step 4. The registry holds no scoped access, so this screen grants
 * nothing: it posts one record to `POST /access-requests` and says so. The
 * honesty tests below are the point of the feature — a word that promises
 * access is a bug, not a copy change.
 *
 * The in-app mock BFF serves no `/access-requests` POST, so the test stubs at
 * the fetch level, like `add-note-dialog.test.tsx`.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { RequestAccessDialog } from "@/components/shared/request-access-dialog";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";

vi.setConfig({ testTimeout: 30_000 });

const FILE_ID = "f-9a41c2d0";
const FILENAME = "bat_cyc_20260814_0941.mf4";
const PORTAL_API = "https://portal-api.dev.quix.io";
const PORTAL_NAME = "Erika Lindqvist";
const REASON = "I need the raw MF4 for the cell-temperature investigation on WO-2026-0847";

/** Any word that would promise the person something this system cannot give. */
const PROMISE_WORDS = /granted|approved|approval|pending review|you now have|unlocked/i;

let calls: Array<{ url: string; init: RequestInit }> = [];
let accessStatus = 201;

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
      if (url.pathname === "/api/proxy/access-requests") {
        if (accessStatus === 201) return json({ id: "j-1" }, 201);
        return json(
          { detail: `File ${FILE_ID} not found`, code: "file_not_found", errors: [] },
          404,
        );
      }
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

function renderDialog() {
  return render(
    <RequestAccessDialog
      entityType="file"
      entityId={FILE_ID}
      entityLabel={FILENAME}
      open
      onOpenChange={() => {}}
    />,
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  accessStatus = 201;
  stubFetch();
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Request-access dialog", () => {
  it("posts the entity, the reason and the signed-in actor", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(PORTAL_NAME);

    await user.type(screen.getByLabelText("Why you need this"), REASON);
    await user.click(screen.getByRole("button", { name: "Record request" }));

    await waitFor(() => expect(postCall("/api/proxy/access-requests")).toBeDefined());
    const body = JSON.parse(postCall("/api/proxy/access-requests").init.body as string);
    expect(body).toEqual({
      entity_type: "file",
      entity_id: FILE_ID,
      reason: REASON,
      actor: PORTAL_NAME,
    });
  });

  it("never tells the person the access was granted", async () => {
    renderDialog();
    await screen.findByText(PORTAL_NAME);

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(PROMISE_WORDS);
    // It says the opposite, in as many words.
    expect(text).toMatch(/cannot grant access/i);
    expect(text).toMatch(/a person reads it and acts outside this system/i);
  });

  it("refuses an empty reason and sends nothing", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(PORTAL_NAME);

    await user.click(screen.getByRole("button", { name: "Record request" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((alert) => /Say why you need this/.test(alert.textContent ?? ""))).toBe(
      true,
    );
    expect(calls.some((entry) => (entry.init.method ?? "GET").toUpperCase() === "POST")).toBe(
      false,
    );
  });

  it("says the id went stale when the registry answers 404", async () => {
    accessStatus = 404;
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(PORTAL_NAME);

    await user.type(screen.getByLabelText("Why you need this"), REASON);
    await user.click(screen.getByRole("button", { name: "Record request" }));

    const alert = await screen.findByText(/holds nothing under this id any more/i);
    expect(alert).toBeDefined();
  });
});
