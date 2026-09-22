/**
 * FR-DM-017, the last open clause — the screen tells a personal search from a
 * team one.
 *
 * The server half landed at `de976f3` and no screen read it, so
 * `SavedSearchButton` still called none of the three routes. This suite drives
 * the wired control: the panel, the hooks, the Portal identity and `fetch`.
 * Only `fetch` and the router are stubs.
 *
 * The device-local store keeps its own suite at `saved-search.test.tsx`. Both
 * lists live in this one panel and neither one replaces the other, so this
 * file also holds the case that proves a device row survives.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { ServerSavedSearch } from "@/types";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { SavedSearchButton } from "@/components/shared/saved-search-button";
import { resetSavedSearchCache, saveSearch } from "@/lib/saved-searches";
import { setPortalApiBase } from "@/lib/portal/client";
import { PORTAL_TOKEN_STORAGE_KEY, setActivePortalToken } from "@/lib/portal/token-store";

const PORTAL_API = "https://portal-api.dev.quix.io";
/** The signed-in person. The Portal profile names her and gives her id. */
const ME = { userId: "u-1", displayName: "Erika Lindqvist" };

/** One request the app sent. The suite reads the method, the path and the body. */
interface Call {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

let calls: Call[] = [];
/** The rows `GET /saved-searches` serves. A test seeds them. */
let stored: ServerSavedSearch[] = [];

function row(over: Partial<ServerSavedSearch> = {}): ServerSavedSearch {
  return {
    search_id: `ss-${over.name ?? "x"}`,
    scope: "runs",
    name: "A search",
    description: null,
    query: "?rig=RIG-01",
    visibility: "personal",
    owner: ME.displayName,
    owner_id: ME.userId,
    saved_at: "2026-08-24T09:41:00Z",
    ...over,
  };
}

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
      const url = new URL(input, "http://localhost:3000");
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({
        method,
        path: url.pathname,
        search: url.search,
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });

      if (url.pathname === "/profile") {
        return json({ userId: ME.userId, email: "e.lindqvist@volvo.com", firstName: "Erika", lastName: "Lindqvist" });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });

      if (url.pathname === "/api/proxy/saved-searches") {
        if (method === "POST") {
          const sent = JSON.parse(init.body as string) as Record<string, string>;
          const saved = row({
            search_id: `ss-${sent.name}`,
            name: sent.name,
            description: sent.description ?? null,
            query: sent.query,
            visibility: sent.visibility as ServerSavedSearch["visibility"],
          });
          stored = [saved, ...stored];
          return json(saved, 201);
        }
        return json({
          items: stored,
          total: stored.length,
          page: 1,
          page_size: 50,
          total_pages: 1,
        });
      }
      if (url.pathname.startsWith("/api/proxy/saved-searches/") && method === "DELETE") {
        const id = decodeURIComponent(url.pathname.split("/").pop() as string);
        stored = stored.filter((entry) => entry.search_id !== id);
        return new Response(null, { status: 204 });
      }
      throw new TypeError(`no stub for ${method} ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Render the control for a person the Portal named. */
function mountSignedIn() {
  window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "portal-pat");
  return render(<SavedSearchButton scope="runs" pathname="/runs" query="?status=complete" />, {
    wrapper: Wrapper,
  });
}

/** Render the control for a person with no Quix Portal token. */
function mountSignedOut() {
  return render(<SavedSearchButton scope="runs" pathname="/runs" query="?status=complete" />, {
    wrapper: Wrapper,
  });
}

async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: /^Saved searches —/ }));
  return screen.getByRole("dialog", { name: "Saved searches" });
}

/** The requests that reached the saved-search routes, in order. */
function searchCalls(): Call[] {
  return calls.filter((call) => call.path.startsWith("/api/proxy/saved-searches"));
}

beforeEach(() => {
  calls = [];
  stored = [];
  push.mockClear();
  setPortalApiBase(PORTAL_API);
  window.localStorage.clear();
  setActivePortalToken(null);
  resetSavedSearchCache();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a person saves a personal search or a team one", () => {
  it("sends visibility personal to POST /saved-searches", async () => {
    const user = userEvent.setup();
    mountSignedIn();
    await openPanel(user);
    await waitFor(() => expect(searchCalls().some((call) => call.method === "GET")).toBe(true));

    await user.type(screen.getByLabelText("Name this search"), "Cold soak");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = searchCalls().find((call) => call.method === "POST");
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({
        scope: "runs",
        name: "Cold soak",
        query: "?status=complete",
        visibility: "personal",
        actor: ME.displayName,
      });
    });
  });

  it("sends visibility team when a person picks Team", async () => {
    const user = userEvent.setup();
    mountSignedIn();
    await openPanel(user);
    await waitFor(() => expect(searchCalls().some((call) => call.method === "GET")).toBe(true));

    await user.type(screen.getByLabelText("Name this search"), "Fleet soak");
    await user.click(screen.getByRole("radio", { name: "Team — everybody here sees it" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = searchCalls().find((call) => call.method === "POST");
      expect(post?.body).toMatchObject({ name: "Fleet soak", visibility: "team" });
    });
  });

  it("saves on the device and calls no route when nobody is signed in", async () => {
    const user = userEvent.setup();
    mountSignedOut();
    await openPanel(user);

    await user.type(screen.getByLabelText("Name this search"), "Local only{Enter}");

    expect(
      await screen.findByRole("button", {
        name: /^Apply the saved search Local only, saved on this device/,
      }),
    ).toBeInTheDocument();
    expect(searchCalls()).toHaveLength(0);
  });
});

describe("the list tells a team search from a personal one, in text", () => {
  beforeEach(() => {
    stored = [
      row({ search_id: "ss-team", name: "Fleet soak", visibility: "team" }),
      row({ search_id: "ss-mine", name: "My soak", visibility: "personal" }),
    ];
  });

  it("marks each row with a word, never a color alone", async () => {
    const user = userEvent.setup();
    mountSignedIn();
    const panel = await openPanel(user);

    const rows = await within(panel).findAllByRole("listitem");
    expect(within(rows[0]).getByText("Team")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Personal")).toBeInTheDocument();
  });

  it("states the same difference in the accessible name of each row", async () => {
    const user = userEvent.setup();
    mountSignedIn();
    await openPanel(user);

    expect(
      await screen.findByRole("button", { name: "Apply the saved search Fleet soak, your team search" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Apply the saved search My soak, your personal search" }),
    ).toBeInTheDocument();
  });

  it("names the owner of a team search a colleague shared", async () => {
    const user = userEvent.setup();
    stored = [
      row({
        search_id: "ss-his",
        name: "Rig sweep",
        visibility: "team",
        owner: "Emanuel Nilsson",
        owner_id: "u-2",
      }),
    ];
    mountSignedIn();
    await openPanel(user);

    expect(
      await screen.findByRole("button", {
        name: "Apply the saved search Rig sweep, a team search from Emanuel Nilsson",
      }),
    ).toBeInTheDocument();
  });
});

describe("the device list and the server list live together", () => {
  it("shows a device row beside the server rows and marks it", async () => {
    const user = userEvent.setup();
    stored = [row({ search_id: "ss-team", name: "Fleet soak", visibility: "team" })];
    saveSearch("runs", "Older device row", "?rig=RIG-09");

    mountSignedIn();
    const panel = await openPanel(user);

    // Both lists reach the panel and the trigger counts both.
    expect(
      await within(panel).findByRole("button", {
        name: "Apply the saved search Older device row, saved on this device",
      }),
    ).toBeInTheDocument();
    // The radio group also carries the word "Team", so read the rows alone.
    const rows = within(panel).getAllByRole("listitem");
    expect(within(rows[0]).getByText("Team")).toBeInTheDocument();
    expect(within(rows[1]).getByText("This device")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saved searches — 2 saved" })).toBeInTheDocument();
  });

  it("keeps serving the device rows when nobody is signed in", async () => {
    const user = userEvent.setup();
    saveSearch("runs", "Older device row", "?rig=RIG-09");
    mountSignedOut();
    const panel = await openPanel(user);

    expect(
      within(panel).getByRole("button", {
        name: "Apply the saved search Older device row, saved on this device",
      }),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/stays on this device/)).toBeInTheDocument();
    // No token, so no route call and no half-built team list.
    expect(searchCalls()).toHaveLength(0);
    // No radio group and no team row, so the word never reaches the screen.
    expect(within(panel).queryByText("Team")).not.toBeInTheDocument();
  });
});

describe("the delete control follows the route", () => {
  it("shows no delete on a team search this caller does not own", async () => {
    const user = userEvent.setup();
    stored = [
      row({ search_id: "ss-mine", name: "My soak", visibility: "team" }),
      row({
        search_id: "ss-his",
        name: "Rig sweep",
        visibility: "team",
        owner: "Emanuel Nilsson",
        owner_id: "u-2",
      }),
    ];
    mountSignedIn();
    await openPanel(user);

    // The route lets the owner alone delete, on a team row as well.
    expect(
      await screen.findByRole("button", { name: "Delete the saved search My soak" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete the saved search Rig sweep" }),
    ).not.toBeInTheDocument();
  });

  it("owns a row the demo path keyed on the name alone", async () => {
    const user = userEvent.setup();
    stored = [
      row({ search_id: "ss-demo", name: "Demo row", owner: ME.displayName, owner_id: null }),
      row({ search_id: "ss-other", name: "Other row", owner: "Emanuel Nilsson", owner_id: null }),
    ];
    mountSignedIn();
    await openPanel(user);

    expect(
      await screen.findByRole("button", { name: "Delete the saved search Demo row" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete the saved search Other row" }),
    ).not.toBeInTheDocument();
  });

  it("sends DELETE with the actor once a person confirms", async () => {
    const user = userEvent.setup();
    stored = [row({ search_id: "ss-mine", name: "My soak", visibility: "team" })];
    mountSignedIn();
    await openPanel(user);

    await user.click(await screen.findByRole("button", { name: "Delete the saved search My soak" }));
    expect(screen.getByText(/Everybody here loses it/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete the saved search My soak" }));

    await waitFor(() => {
      const call = searchCalls().find((entry) => entry.method === "DELETE");
      expect(call?.path).toBe("/api/proxy/saved-searches/ss-mine");
      expect(call?.body).toEqual({ actor: ME.displayName });
    });
  });
});

describe("every control states what it does", () => {
  it("names the trigger, the field, the two choices and the row controls", async () => {
    const user = userEvent.setup();
    stored = [row({ search_id: "ss-mine", name: "My soak", visibility: "personal" })];
    mountSignedIn();
    await openPanel(user);

    expect(screen.getByRole("button", { name: "Saved searches — 1 saved" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name this search")).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Personal — only you see it" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Team — everybody here sees it" })).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Apply the saved search My soak, your personal search" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete the saved search My soak" }),
    ).toBeInTheDocument();
  });
});

describe("the optional description (FR-DM-017)", () => {
  it("carries a real label, not a placeholder", async () => {
    const user = userEvent.setup();
    mountSignedIn();
    const panel = await openPanel(user);

    const field = within(panel).getByLabelText("Description (optional)");
    expect(field.tagName).toBe("INPUT");
    // A real <label> element points at the field, so it stays on screen.
    expect(within(panel).getByText("Description (optional)").tagName).toBe("LABEL");
  });

  it("sends the description to POST /saved-searches", async () => {
    const user = userEvent.setup();
    mountSignedIn();
    await openPanel(user);
    await waitFor(() => expect(searchCalls().some((call) => call.method === "GET")).toBe(true));

    await user.type(screen.getByLabelText("Name this search"), "Cold soak");
    await user.type(screen.getByLabelText("Description (optional)"), "Every complete run on rig 4.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = searchCalls().find((call) => call.method === "POST");
      expect(post?.body).toMatchObject({
        name: "Cold soak",
        description: "Every complete run on rig 4.",
      });
    });
  });

  it("sends null when nobody writes one, so the save works as it always did", async () => {
    const user = userEvent.setup();
    mountSignedIn();
    await openPanel(user);
    await waitFor(() => expect(searchCalls().some((call) => call.method === "GET")).toBe(true));

    await user.type(screen.getByLabelText("Name this search"), "Cold soak");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = searchCalls().find((call) => call.method === "POST");
      expect(post?.body).toMatchObject({ name: "Cold soak", description: null });
    });
  });

  it("shows the description on the row and keeps it out of the row's name", async () => {
    const user = userEvent.setup();
    stored = [
      row({
        search_id: "ss-mine",
        name: "My soak",
        description: "Every complete run on rig 4.",
      }),
    ];
    mountSignedIn();
    const panel = await openPanel(user);

    // A person reads it.
    expect(await within(panel).findByText("Every complete run on rig 4.")).toBeInTheDocument();
    // A screen reader reaches it, and the name stays one short phrase.
    const apply = within(panel).getByRole("button", {
      name: "Apply the saved search My soak, your personal search",
    });
    expect(apply).toHaveAccessibleDescription("Every complete run on rig 4.");
  });

  it("gives a row with no description no description at all", async () => {
    const user = userEvent.setup();
    stored = [row({ search_id: "ss-mine", name: "My soak", description: null })];
    mountSignedIn();
    const panel = await openPanel(user);

    const apply = await within(panel).findByRole("button", {
      name: "Apply the saved search My soak, your personal search",
    });
    expect(apply).not.toHaveAttribute("aria-describedby");
  });

  it("saves a description on the device when nobody is signed in", async () => {
    const user = userEvent.setup();
    mountSignedOut();
    const panel = await openPanel(user);

    await user.type(screen.getByLabelText("Name this search"), "Local only");
    await user.type(screen.getByLabelText("Description (optional)"), "On this device alone.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await within(panel).findByText("On this device alone.")).toBeInTheDocument();
    expect(searchCalls()).toHaveLength(0);
  });
});
