/**
 * The QuixLab picker and the embedded frame.
 *
 * Two things this file exists to prove, and they are the two that decide
 * whether the demo survives:
 *
 *   1. **Every** `REQUEST_AUTH_TOKEN` is answered, with the token the browser
 *      holds at that moment. QuixLab asks again 60 s before each token
 *      expires, so a handler that answers once looks perfect in rehearsal and
 *      dies about twenty minutes in.
 *   2. Nothing is answered without an origin check, and no message and no URL
 *      ever carries a credential to a page we did not frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";

/* The panel no longer lists the workspace's QuixLabs: it asks for the one lab
   this viewer has for this run, and offers to make it. */
const { closeRunQuixLab, createRunQuixLab, getRunQuixLab } = vi.hoisted(() => ({
  closeRunQuixLab: vi.fn(),
  createRunQuixLab: vi.fn(),
  getRunQuixLab: vi.fn(),
}));
vi.mock("@/lib/api/run-quixlab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/run-quixlab")>()),
  closeRunQuixLab,
  createRunQuixLab,
  getRunQuixLab,
}));

import { QuixLabPanel } from "@/components/screens/run-detail/quixlab-panel";
import { QuixLabFrame } from "@/components/shared/quixlab-frame";
import { ApiError } from "@/lib/api/client";
import { setActivePortalToken } from "@/lib/portal/token-store";
import type { RunQuixLab } from "@/lib/api/run-quixlab";
import { setQuixLabUrl, type QuixLabInstance } from "@/lib/quixlab";

const RUN_ID = "RUN-2026-0042";
const SESSION_ORIGIN = "https://quixlab-sess9.dev.quix.io";
const LAB_ORIGIN = "https://tm-lab-ana-run42.dev.quix.io";

/** This viewer's lab for this run, as the run-scoped route answers it. */
function lab(over: Partial<RunQuixLab> = {}): RunQuixLab {
  return {
    id: "dep-lab",
    name: "tm-lab-ana-run42",
    status: "Running",
    url: LAB_ORIGIN,
    notebook: `blob://ws/quixlab-runs/${RUN_ID}/analysis.py`,
    created: false,
    ...over,
  };
}
const SHARED_ORIGIN = "https://quixlab-dep1.dev.quix.io";

function instance(over: Partial<QuixLabInstance> = {}): QuixLabInstance {
  const base: QuixLabInstance = {
    id: "dep-1",
    name: "QuixLab shared",
    kind: "deployment",
    status: "Running",
    url: SHARED_ORIGIN,
    embed_url: `${SHARED_ORIGIN}?isIframe=true`,
    origin: SHARED_ORIGIN,
  };
  return { ...base, ...over };
}

/** Post a message the way a browser posts one: the browser sets the origin. */
function fire(origin: string, data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin }));
  });
}

interface Posted {
  message: unknown;
  target: unknown;
}

/** Mount the frame and watch every message it posts into the child window. */
async function mountFrame(target = instance(), runId = RUN_ID) {
  const view = render(
    <QuixLabFrame embedUrl={target.embed_url} origin={target.origin} runId={runId} />,
  );
  const frame = view.container.querySelector("iframe");
  if (frame === null) throw new Error("the frame did not render");
  // The effect sets the src, so the listener is mounted before the load.
  await waitFor(() => expect(frame.getAttribute("src")).toBe(target.embed_url));

  const child = frame.contentWindow;
  if (child === null) throw new Error("the frame has no child window");
  const posted: Posted[] = [];
  const spy = vi.spyOn(child, "postMessage");
  spy.mockImplementation(((message: unknown, targetOrigin: unknown) => {
    posted.push({ message, target: targetOrigin });
  }) as typeof child.postMessage);

  return { view, frame, posted };
}

/** The panel invalidates the results queries on Save and Close, so it needs a client. */
function withClient(node: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  closeRunQuixLab.mockReset();
  createRunQuixLab.mockReset();
  getRunQuixLab.mockReset();
  // A panel that never resolves its lookup would leave every frame test racing
  // a pending promise, so the default is the ordinary "you have none yet".
  getRunQuixLab.mockRejectedValue(new ApiError(404, "no QuixLab for this run yet", "quixlab_not_found"));
  setActivePortalToken(null);
  setQuixLabUrl(null);
});

afterEach(() => {
  setActivePortalToken(null);
  setQuixLabUrl(null);
  vi.restoreAllMocks();
});

describe("the frame answers the token handshake", () => {
  it("answers EVERY REQUEST_AUTH_TOKEN, with the token held at that moment", async () => {
    setActivePortalToken("token-one");
    const { posted } = await mountFrame();

    fire(SHARED_ORIGIN, { type: "REQUEST_AUTH_TOKEN" });
    expect(posted).toHaveLength(1);
    expect(posted[0].message).toEqual({ type: "AUTH_TOKEN", token: "token-one" });

    // The Portal refreshed the token, and QuixLab asks again 60 s before the
    // first one expires. The second answer must carry the NEW token, which
    // only a handler that reads at reply time can do.
    setActivePortalToken("token-two");
    fire(SHARED_ORIGIN, { type: "REQUEST_AUTH_TOKEN" });

    expect(posted).toHaveLength(2);
    expect(posted[1].message).toEqual({ type: "AUTH_TOKEN", token: "token-two" });
  });

  it("posts to the instance origin, and never to a wildcard", async () => {
    setActivePortalToken("token-one");
    const { posted } = await mountFrame();

    fire(SHARED_ORIGIN, { type: "REQUEST_AUTH_TOKEN" });
    fire(SHARED_ORIGIN, { type: "REQUEST_TM_IMPORT" });

    expect(posted.map((entry) => entry.target)).toEqual([SHARED_ORIGIN, SHARED_ORIGIN]);
  });

  it("says nothing to a message from any other origin", async () => {
    setActivePortalToken("token-one");
    const { posted } = await mountFrame();

    fire("https://attacker.example", { type: "REQUEST_AUTH_TOKEN" });
    fire("https://portal.dev.quix.io", { type: "REQUEST_AUTH_TOKEN" });
    fire(SESSION_ORIGIN, { type: "REQUEST_TM_IMPORT" });

    expect(posted).toEqual([]);
  });

  it("stays silent with no token, and answers the next request once one arrives", async () => {
    const { posted, view } = await mountFrame();

    fire(SHARED_ORIGIN, { type: "REQUEST_AUTH_TOKEN" });
    expect(posted).toEqual([]);
    expect(view.getByRole("status").textContent).toContain("sign in");

    setActivePortalToken("token-late");
    fire(SHARED_ORIGIN, { type: "REQUEST_AUTH_TOKEN" });

    expect(posted).toHaveLength(1);
    expect(posted[0].message).toEqual({ type: "AUTH_TOKEN", token: "token-late" });
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
  });

  it("stops listening when the frame goes away", async () => {
    setActivePortalToken("token-one");
    const { posted, view } = await mountFrame();

    view.unmount();
    fire(SHARED_ORIGIN, { type: "REQUEST_AUTH_TOKEN" });

    expect(posted).toEqual([]);
  });
});

describe("the frame opens one named run", () => {
  it("posts TM_IMPORT with the run on screen", async () => {
    setActivePortalToken("token-one");
    const { posted } = await mountFrame(instance(), RUN_ID);

    fire(SHARED_ORIGIN, { type: "REQUEST_TM_IMPORT" });

    expect(posted).toHaveLength(1);
    expect(posted[0].message).toEqual({ type: "TM_IMPORT", runId: RUN_ID });
  });

  it("frames the embed URL the API built, and it carries no credential", async () => {
    setActivePortalToken("token-one");
    const { frame } = await mountFrame();

    const src = frame.getAttribute("src") ?? "";
    expect(src).toBe(`${SHARED_ORIGIN}?isIframe=true`);
    for (const secret of ["token", "secret", "password", "bearer"]) {
      expect(src.toLowerCase()).not.toContain(secret);
    }
    // A sandbox without allow-same-origin kills QuixLab's session cookie.
    expect(frame.hasAttribute("sandbox")).toBe(false);
  });
});

describe("the notebook", () => {
  it("offers to create one, and makes nothing on mount", async () => {
    // A lab is a container. Opening a run to read its files must not bill for one.
    getRunQuixLab.mockRejectedValue(new ApiError(404, "no QuixLab for this run yet", "quixlab_not_found"));

    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));

    await waitFor(() => expect(getRunQuixLab).toHaveBeenCalledWith(RUN_ID));
    expect(view.getByRole("button", { name: "Create QuixLab notebook" })).toBeTruthy();
    expect(createRunQuixLab).not.toHaveBeenCalled();
    expect(view.container.querySelector("iframe")).toBeNull();
  });

  it("offers to open a saved one, and never makes a second", async () => {
    getRunQuixLab.mockResolvedValue(lab({ status: "Stopped" }));

    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));

    await waitFor(() => expect(view.getByText(/tm-lab-ana-run42/)).toBeTruthy());
    expect(view.getByRole("button", { name: "Open QuixLab notebook" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Create QuixLab notebook" })).toBeNull();
    expect(createRunQuixLab).not.toHaveBeenCalled();
  });

  it("one click creates it, waits for it, and embeds it", async () => {
    /* The button reports the progress itself: a deployment answers Building before
       anything serves on its address, and a frame opened then shows a 502 that never
       refreshes. */
    getRunQuixLab
      .mockRejectedValueOnce(new ApiError(404, "none", "quixlab_not_found"))
      .mockResolvedValue(lab());
    createRunQuixLab.mockResolvedValue(lab({ status: "Building", created: true }));
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    await waitFor(() => view.getByRole("button", { name: "Create QuixLab notebook" }));

    await userEvent.setup().click(view.getByRole("button", { name: "Create QuixLab notebook" }));

    await waitFor(() => expect(createRunQuixLab).toHaveBeenCalledWith(RUN_ID));
    await waitFor(() => expect(view.getByRole("button", { name: /Starting/ })).toBeTruthy());
    const frame = await waitFor(() => {
      const found = view.container.querySelector("iframe");
      if (found === null) throw new Error("no frame yet");
      return found;
    }, { timeout: 5000 });
    await waitFor(() => expect(frame.getAttribute("src")).toBe(`${LAB_ORIGIN}?isIframe=true`));
    expect(view.getByRole("button", { name: "Save and Close" })).toBeTruthy();
  });

  it("says why, when it cannot be made", async () => {
    getRunQuixLab.mockRejectedValue(new ApiError(404, "none", "quixlab_not_found"));
    createRunQuixLab.mockRejectedValue(
      new ApiError(503, "the workspace holds no QuixLab deployment to clone", "quixlab_no_template"),
    );
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    await waitFor(() => view.getByRole("button", { name: "Create QuixLab notebook" }));

    await userEvent.setup().click(view.getByRole("button", { name: "Create QuixLab notebook" }));

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("no QuixLab deployment to clone");
  });
});

describe("Save and Close", () => {
  async function opened() {
    getRunQuixLab.mockResolvedValue(lab());
    createRunQuixLab.mockResolvedValue(lab());
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    await waitFor(() => view.getByRole("button", { name: "Open QuixLab notebook" }));
    await userEvent.setup().click(view.getByRole("button", { name: "Open QuixLab notebook" }));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    return view;
  }

  it("files the notebook under the run, stops the lab and closes the frame", async () => {
    closeRunQuixLab.mockResolvedValue(lab({ status: "Stopping", saved_result_id: "res-1" }));
    const view = await opened();

    await userEvent.setup().click(view.getByRole("button", { name: "Save and Close" }));

    await waitFor(() => expect(closeRunQuixLab).toHaveBeenCalledWith(RUN_ID));
    await waitFor(() => expect(view.container.querySelector("iframe")).toBeNull());
    expect(view.getByText(/Saved under this run/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Open QuixLab notebook" })).toBeTruthy();
  });

  it("keeps the frame when the save is refused, so nothing is lost", async () => {
    closeRunQuixLab.mockRejectedValue(new ApiError(503, "the notebook could not be saved", "storage_unreachable"));
    const view = await opened();

    await userEvent.setup().click(view.getByRole("button", { name: "Save and Close" }));

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("could not be saved");
    expect(view.container.querySelector("iframe")).not.toBeNull();
  });

  it("opens the whole run in a tab, with no credential and no opener", async () => {
    getRunQuixLab.mockResolvedValue(lab());
    const opens: unknown[][] = [];
    const open = vi.spyOn(window, "open").mockImplementation((...args: unknown[]) => {
      opens.push(args);
      return null;
    });
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    await waitFor(() => view.getByRole("button", { name: /Open in a tab/ }));

    await userEvent.setup().click(view.getByRole("button", { name: /Open in a tab/ }));

    expect(opens).toHaveLength(1);
    expect(opens[0][0]).toBe(LAB_ORIGIN);
    expect(String(opens[0][2])).toContain("noopener");
    open.mockRestore();
  });
});
