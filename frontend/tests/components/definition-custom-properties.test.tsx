/**
 * The Custom properties card on the test definition detail screen.
 *
 * A test definition is a read-only mirror of the planning system. These pairs
 * are the one thing a person owns on it, so they sit in their own card and
 * never in the planning grid. Each test drives the real path: the panel, the
 * hook, the API client and `fetch`. Only `fetch` is a stub, so the request the
 * browser sends is the thing under test. The route is
 * `api/api/routers/test_definitions.py` (PATCH custom-properties).
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { CustomPropertiesPanel } from "@/components/screens/definitions/custom-properties-panel";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";

vi.setConfig({ testTimeout: 30_000 });

const TD_ID = "TD-BAT-114";
const PORTAL_API = "https://portal-api.dev.quix.io";

/** Every request the app sent, in order. */
let calls: Array<{ url: string; init: RequestInit }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(answer: () => Response): void {
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
      if (url.pathname === `/api/proxy/test-definitions/${TD_ID}/custom-properties`) {
        return answer();
      }
      throw new TypeError(`no stub for ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The one PATCH the app sent to the property route. */
function patchBody(): Record<string, unknown> {
  const call = calls.find((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH");
  if (call === undefined) throw new Error("the app sent no PATCH to the property route");
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

function patchCount(): number {
  return calls.filter((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH").length;
}

function show(properties: Record<string, string>) {
  render(<CustomPropertiesPanel tdId={TD_ID} properties={properties} />, { wrapper: Wrapper });
  return userEvent.setup();
}

async function edit(properties: Record<string, string>) {
  const user = show(properties);
  await user.click(screen.getByRole("button", { name: "Edit properties" }));
  return user;
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  stubFetch(() => json({ custom_properties: {} }));
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the card shows what the definition carries", () => {
  it("lists every stored pair", () => {
    show({ "chamber id": "CH-02", fixture: "FX-114-B" });

    expect(screen.getByText("chamber id")).toBeInTheDocument();
    expect(screen.getByText("CH-02")).toBeInTheDocument();
    expect(screen.getByText("fixture")).toBeInTheDocument();
    expect(screen.getByText("FX-114-B")).toBeInTheDocument();
  });

  it("says so when the definition carries none", () => {
    show({});

    expect(
      screen.getByText("This definition carries no custom property yet."),
    ).toBeInTheDocument();
  });

  it("sits in its own card and names the person as author", () => {
    show({ "chamber id": "CH-02" });

    // The card names itself, and it names the owner of the pairs.
    expect(screen.getByRole("heading", { name: "Custom properties" })).toBeInTheDocument();
    expect(screen.getByText(/a person authors every pair here/)).toBeInTheDocument();
  });

  it("never shows api:planning", () => {
    show({ "chamber id": "CH-02" });

    expect(screen.queryByText("api:planning")).toBeNull();
  });
});

describe("the editor sends the whole map", () => {
  it("puts one labelled row per stored pair", async () => {
    await edit({ "chamber id": "CH-02" });

    expect(screen.getByLabelText("Custom property 1 name")).toHaveValue("chamber id");
    expect(screen.getByLabelText("Custom property 1 value")).toHaveValue("CH-02");
  });

  it("sends the added pair beside the stored ones", async () => {
    const user = await edit({ "chamber id": "CH-02" });

    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.type(screen.getByLabelText("Custom property 2 name"), "fixture");
    await user.type(screen.getByLabelText("Custom property 2 value"), "FX-114-B");
    await user.click(screen.getByRole("button", { name: "Save properties" }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody().custom_properties).toEqual({
      "chamber id": "CH-02",
      fixture: "FX-114-B",
    });
  });

  it("sends an empty object when every row goes", async () => {
    const user = await edit({ "chamber id": "CH-02" });

    await user.click(
      screen.getByRole("button", { name: "Remove the custom property chamber id" }),
    );
    await user.click(screen.getByRole("button", { name: "Save properties" }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody().custom_properties).toEqual({});
  });

  it("sends nothing when no row changed", async () => {
    const user = await edit({ "chamber id": "CH-02" });

    await user.click(screen.getByRole("button", { name: "Save properties" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing changed yet");
    expect(patchCount()).toBe(0);
  });
});

describe("the editor refuses a save it can name", () => {
  it("refuses an empty name", async () => {
    const user = await edit({});

    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.type(screen.getByLabelText("Custom property 1 value"), "CH-02");
    await user.click(screen.getByRole("button", { name: "Save properties" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A custom property needs a name");
    expect(patchCount()).toBe(0);
  });

  it("refuses a name above the 64-character cap", async () => {
    const user = await edit({ ["k".repeat(65)]: "v" });

    // The stored name is already too long, so a value edit still refuses.
    await user.type(screen.getByLabelText("Custom property 1 value"), "x");
    await user.click(screen.getByRole("button", { name: "Save properties" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("longer than 64 characters");
    expect(patchCount()).toBe(0);
  });

  it("refuses a value above the 512-character cap", async () => {
    const user = await edit({ note: "v".repeat(513) });

    await user.type(screen.getByLabelText("Custom property 1 name"), "s");
    await user.click(screen.getByRole("button", { name: "Save properties" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("longer than 512 characters");
    expect(patchCount()).toBe(0);
  });

  it("prints the sentence of the code the API answers", async () => {
    stubFetch(() =>
      json(
        {
          detail: "A custom property map holds 50 properties at most",
          code: "too_many_custom_properties",
        },
        422,
      ),
    );
    const user = await edit({ "chamber id": "CH-02" });

    await user.type(screen.getByLabelText("Custom property 1 value"), "-B");
    await user.click(screen.getByRole("button", { name: "Save properties" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A custom property map holds 50 properties at most. Remove a row and save again.",
    );
  });
});
