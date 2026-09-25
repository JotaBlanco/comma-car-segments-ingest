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

/* The panel no longer lists the workspace's QuixLabs: it lists the run's
   notebooks, and opens each in a lab of this viewer's own. */
const {
  closeNotebook,
  createNotebook,
  deleteNotebook,
  getNotebookLab,
  listNotebooks,
  openNotebook,
  stopNotebook,
} = vi.hoisted(() => ({
  closeNotebook: vi.fn(),
  createNotebook: vi.fn(),
  deleteNotebook: vi.fn(),
  getNotebookLab: vi.fn(),
  listNotebooks: vi.fn(),
  openNotebook: vi.fn(),
  stopNotebook: vi.fn(),
}));
vi.mock("@/lib/api/run-quixlab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/run-quixlab")>()),
  closeNotebook,
  createNotebook,
  deleteNotebook,
  getNotebookLab,
  listNotebooks,
  openNotebook,
  stopNotebook,
}));

vi.mock("@/lib/quixlab-ready", () => ({ waitForLab: vi.fn(() => Promise.resolve(true)) }));

import {
  FRAME_PATIENCE_MS,
  FRAME_RELOADS,
  QuixLabFrame,
  QuixLabPanel,
} from "@/components/screens/run-detail/quixlab-panel";
import { ApiError } from "@/lib/api/client";
import { setActivePortalToken } from "@/lib/portal/token-store";
import type { Notebook, RunQuixLab } from "@/lib/api/run-quixlab";
import { setQuixLabUrl, type QuixLabInstance } from "@/lib/quixlab";

const RUN_ID = "RUN-2026-0042";
const SESSION_ORIGIN = "https://quixlab-sess9.dev.quix.io";
const LAB_ORIGIN = "https://tm-lab-ana-run42.dev.quix.io";

/** This viewer's lab on a notebook, as the lab route answers it. */
function lab(over: Partial<RunQuixLab> = {}): RunQuixLab {
  return {
    id: "dep-lab",
    name: "tm-lab-ana-run42",
    status: "Running",
    url: LAB_ORIGIN,
    notebook: `blob://ws/quixlab-runs/${RUN_ID}/nb-1/analysis.py`,
    created: false,
    ...over,
  };
}

/** One of the run's notebooks, as the list answers it. */
function notebook(over: Partial<Notebook> = {}): Notebook {
  return {
    notebook_id: "nb-1",
    run_id: RUN_ID,
    name: "Notebook 1",
    created_by: "Ana",
    created_at: "2026-09-22T09:00:00Z",
    saved_at: null,
    lab: null,
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
  const view = render(<QuixLabFrame instance={target} runId={runId} />);
  const frame = view.container.querySelector("iframe");
  if (frame === null) throw new Error("the frame did not render");
  // The effect sets the src, so the listener is mounted before the load.
  await waitFor(() => expect(frame.getAttribute("src")).toBe(`${target.embed_url}&theme=light`));

  const child = frame.contentWindow;
  if (child === null) throw new Error("the frame has no child window");
  const posted: Posted[] = [];
  // The theme is posted on its own: every fresh page of the lab gets one, so it is kept
  // apart from the messages the handshake tests count.
  const themes: Posted[] = [];
  const spy = vi.spyOn(child, "postMessage");
  spy.mockImplementation(((message: unknown, targetOrigin: unknown) => {
    const kind = (message as { type?: unknown } | null)?.type;
    (kind === "QUIXLAB_THEME" ? themes : posted).push({ message, target: targetOrigin });
  }) as typeof child.postMessage);

  return { view, frame, posted, themes };
}

/** The panel invalidates the results queries on Save and Close, so it needs a client. */
function withClient(node: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  closeNotebook.mockReset();
  createNotebook.mockReset();
  deleteNotebook.mockReset();
  stopNotebook.mockReset();
  getNotebookLab.mockReset();
  listNotebooks.mockReset();
  openNotebook.mockReset();
  // A panel that never resolves its list would leave every frame test racing
  // a pending promise, so the default is the ordinary "none yet".
  listNotebooks.mockResolvedValue([]);
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
    expect(src).toBe(`${SHARED_ORIGIN}?isIframe=true&theme=light`);
    for (const secret of ["token", "secret", "password", "bearer"]) {
      expect(src.toLowerCase()).not.toContain(secret);
    }
    // A sandbox without allow-same-origin kills QuixLab's session cookie.
    expect(frame.hasAttribute("sandbox")).toBe(false);
  });
});

describe("the frame follows this page's theme", () => {
  afterEach(() => document.documentElement.classList.remove("dark"));

  it("loads the lab in the theme this page shows", async () => {
    document.documentElement.classList.add("dark");
    const view = render(<QuixLabFrame instance={instance()} runId={RUN_ID} />);
    const frame = view.container.querySelector("iframe");

    await waitFor(() =>
      expect(frame?.getAttribute("src")).toBe(`${SHARED_ORIGIN}?isIframe=true&theme=dark`),
    );
  });

  it("posts the switch down, and never reloads the frame for it", async () => {
    const { themes, frame } = await mountFrame();
    const before = frame.getAttribute("src");

    document.documentElement.classList.add("dark");
    await waitFor(() => expect(themes).toHaveLength(1));

    expect(themes[0]).toEqual({ message: { type: "QUIXLAB_THEME", theme: "dark" }, target: SHARED_ORIGIN });
    expect(frame.getAttribute("src")).toBe(before);
  });

  it("hands the theme to every page of the lab as it loads, whatever its address carried", async () => {
    // The gate asks for a token; the app says READY after the gate's jump dropped the query.
    setActivePortalToken("token-one");
    const { themes } = await mountFrame();

    fire(SHARED_ORIGIN, { type: "REQUEST_AUTH_TOKEN" });
    fire(SHARED_ORIGIN, { type: "QUIXLAB_READY" });
    fire("https://attacker.example", { type: "QUIXLAB_READY" });

    expect(themes.map((p) => p.message)).toEqual([
      { type: "QUIXLAB_THEME", theme: "light" },
      { type: "QUIXLAB_THEME", theme: "light" },
    ]);
    expect(themes.every((p) => p.target === SHARED_ORIGIN)).toBe(true);
  });
});

describe("the frame reloads a lab that says nothing", () => {
  /* The ingress answers for a lab still starting with its own error page,
     which never posts a message and never refreshes itself. */
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("reloads after FRAME_PATIENCE_MS of silence, with a cache-busting counter", async () => {
    const { frame, view } = await mountFrame();
    const first = frame.getAttribute("src");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_PATIENCE_MS + 10);
    });

    expect(frame.getAttribute("src")).toBe(`${first}&reload=1`);
    expect(view.getByRole("status").textContent).toContain("reloaded (1 of");
  });

  it("stops the clock the moment the lab speaks, whatever it says", async () => {
    const { frame } = await mountFrame();
    const first = frame.getAttribute("src");

    fire(SHARED_ORIGIN, { type: "QUIXLAB_READY" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_PATIENCE_MS * 3);
    });

    expect(frame.getAttribute("src")).toBe(first);
  });

  it("gives up after FRAME_RELOADS and says what to do", async () => {
    const { frame, view } = await mountFrame();

    for (let i = 0; i <= FRAME_RELOADS; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FRAME_PATIENCE_MS + 10);
      });
    }

    expect(frame.getAttribute("src")).toContain(`&reload=${FRAME_RELOADS}`);
    expect(view.getByRole("alert").textContent).toContain("did not answer");
  });
});

describe("the notebooks", () => {
  it("offers to create one, and makes nothing on mount", async () => {
    // A lab is a container. Opening a run to read its files must not bill for one.
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));

    await waitFor(() => expect(listNotebooks).toHaveBeenCalledWith(RUN_ID));
    await waitFor(() => expect(view.getByText(/No notebooks yet/)).toBeTruthy());
    expect(view.getByRole("button", { name: "Create QuixLab notebook" })).toBeTruthy();
    expect(createNotebook).not.toHaveBeenCalled();
    expect(openNotebook).not.toHaveBeenCalled();
    expect(view.container.querySelector("iframe")).toBeNull();
  });

  it("lists every saved one with an Open control, and still offers to create", async () => {
    // The idea is several notebooks per run: each is its own file and its own lab.
    listNotebooks.mockResolvedValue([
      notebook({ saved_at: "2026-09-22T10:00:00Z", lab: lab({ status: "Stopped" }) }),
      notebook({ notebook_id: "nb-2", name: "Flutter sweep", created_by: "Ben" }),
    ]);

    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));

    await waitFor(() => expect(view.getByRole("button", { name: "Open Notebook 1" })).toBeTruthy());
    expect(view.getByRole("button", { name: "Open Flutter sweep" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Create QuixLab notebook" })).toBeTruthy();
    expect(view.getByText(/QuixLab stopped/)).toBeTruthy();
    expect(view.getByText(/never saved/)).toBeTruthy();
    expect(createNotebook).not.toHaveBeenCalled();
    expect(openNotebook).not.toHaveBeenCalled();
  });

  it("one click creates one, waits for it, and embeds it", async () => {
    /* The button reports the progress itself: a deployment answers Building before
       anything serves on its address, and a frame opened then shows a 502 that never
       refreshes. */
    createNotebook.mockResolvedValue(notebook({ lab: lab({ status: "Building", created: true }) }));
    getNotebookLab.mockResolvedValue(lab());
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    await waitFor(() => view.getByRole("button", { name: "Create QuixLab notebook" }));

    await userEvent.setup().click(view.getByRole("button", { name: "Create QuixLab notebook" }));

    await waitFor(() => expect(createNotebook).toHaveBeenCalledWith(RUN_ID));
    await waitFor(() => expect(view.getByRole("button", { name: /Starting/ })).toBeTruthy());
    const frame = await waitFor(() => {
      const found = view.container.querySelector("iframe");
      if (found === null) throw new Error("no frame yet");
      return found;
    }, { timeout: 5000 });
    await waitFor(() => expect(frame.getAttribute("src")).toBe(`${LAB_ORIGIN}?isIframe=true&theme=light`));
    expect(getNotebookLab).toHaveBeenCalledWith(RUN_ID, "nb-1");
    expect(view.getByRole("button", { name: "Save and Close" })).toBeTruthy();
  });

  it("opens a saved one where it was left, and writes no new file", async () => {
    listNotebooks.mockResolvedValue([notebook({ saved_at: "2026-09-22T10:00:00Z" })]);
    openNotebook.mockResolvedValue(notebook({ lab: lab() }));
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    await waitFor(() => view.getByRole("button", { name: "Open Notebook 1" }));

    await userEvent.setup().click(view.getByRole("button", { name: "Open Notebook 1" }));

    await waitFor(() => expect(openNotebook).toHaveBeenCalledWith(RUN_ID, "nb-1"));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    expect(createNotebook).not.toHaveBeenCalled();
  });

  it("says why, when it cannot be made", async () => {
    createNotebook.mockRejectedValue(
      new ApiError(503, "the workspace holds no QuixLab deployment to clone", "quixlab_no_template"),
    );
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    await waitFor(() => view.getByRole("button", { name: "Create QuixLab notebook" }));

    await userEvent.setup().click(view.getByRole("button", { name: "Create QuixLab notebook" }));

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("no QuixLab deployment to clone");
  });
});

describe("stopping a notebook from the list", () => {
  it("offers Stop only where a lab is up, stops it and refreshes", async () => {
    listNotebooks.mockResolvedValue([
      notebook({ lab: lab() }),
      notebook({ notebook_id: "nb-2", name: "Parked", lab: lab({ status: "Stopped" }) }),
      notebook({ notebook_id: "nb-3", name: "Never opened" }),
    ]);
    stopNotebook.mockResolvedValue(notebook({ lab: lab({ status: "Stopping" }) }));
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    const stop = await view.findByRole("button", { name: "Stop Notebook 1" });
    expect(view.queryByRole("button", { name: "Stop Parked" })).toBeNull();
    expect(view.queryByRole("button", { name: "Stop Never opened" })).toBeNull();

    listNotebooks.mockResolvedValue([notebook({ lab: lab({ status: "Stopped" }) })]);
    await userEvent.setup().click(stop);

    await waitFor(() => expect(stopNotebook).toHaveBeenCalledWith(RUN_ID, "nb-1"));
    await waitFor(() => expect(view.queryByRole("button", { name: "Stop Notebook 1" })).toBeNull());
    expect(view.getByText(/QuixLab stopped/)).toBeTruthy();
  });
});

describe("arriving from Open in → New QuixLab notebook", () => {
  it("creates one notebook on mount, once, and hands the request back", async () => {
    createNotebook.mockResolvedValue(notebook({ lab: lab() }));
    const handled = vi.fn();
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} createOnMount onCreateHandled={handled} />));

    await waitFor(() => expect(createNotebook).toHaveBeenCalledWith(RUN_ID));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    view.rerender(withClient(<QuixLabPanel runId={RUN_ID} createOnMount onCreateHandled={handled} />));

    expect(createNotebook).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledTimes(1);
  });
});

describe("deleting a notebook", () => {
  it("asks once on the button, then removes it and refreshes the list", async () => {
    listNotebooks.mockResolvedValue([notebook(), notebook({ notebook_id: "nb-2", name: "Second" })]);
    deleteNotebook.mockResolvedValue(undefined);
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    const user = userEvent.setup();
    const button = await view.findByRole("button", { name: "Delete Second" });

    await user.click(button);
    expect(deleteNotebook).not.toHaveBeenCalled();
    expect(view.getByRole("button", { name: "Confirm deleting Second" })).toBeTruthy();

    listNotebooks.mockResolvedValue([notebook()]);
    await user.click(view.getByRole("button", { name: "Confirm deleting Second" }));

    await waitFor(() => expect(deleteNotebook).toHaveBeenCalledWith(RUN_ID, "nb-2"));
    await waitFor(() => expect(view.queryByRole("button", { name: /Second$/ })).toBeNull());
    expect(view.getByRole("button", { name: "Open Notebook 1" })).toBeTruthy();
  });

  it("disarms when the person clicks elsewhere", async () => {
    listNotebooks.mockResolvedValue([notebook()]);
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    const user = userEvent.setup();
    await user.click(await view.findByRole("button", { name: "Delete Notebook 1" }));
    expect(view.getByRole("button", { name: "Confirm deleting Notebook 1" })).toBeTruthy();

    await user.tab();

    expect(view.getByRole("button", { name: "Delete Notebook 1" })).toBeTruthy();
    expect(deleteNotebook).not.toHaveBeenCalled();
  });

  it("says why when the delete is refused, and keeps the notebook listed", async () => {
    listNotebooks.mockResolvedValue([notebook()]);
    deleteNotebook.mockRejectedValue(new ApiError(503, "the Quix platform did not answer", "quixlab_unreachable"));
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    const user = userEvent.setup();
    await user.click(await view.findByRole("button", { name: "Delete Notebook 1" }));
    await user.click(view.getByRole("button", { name: "Confirm deleting Notebook 1" }));

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("did not answer");
    expect(view.getByRole("button", { name: "Open Notebook 1" })).toBeTruthy();
  });
});

describe("Save and Close", () => {
  async function opened() {
    listNotebooks.mockResolvedValue([notebook({ lab: lab({ status: "Stopped" }) })]);
    openNotebook.mockResolvedValue(notebook({ lab: lab() }));
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
    await waitFor(() => view.getByRole("button", { name: "Open Notebook 1" }));
    await userEvent.setup().click(view.getByRole("button", { name: "Open Notebook 1" }));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    return view;
  }

  it("records the save, stops the lab and closes the frame, back to the list", async () => {
    closeNotebook.mockResolvedValue(
      notebook({ saved_at: "2026-09-22T11:00:00Z", lab: lab({ status: "Stopping" }) }),
    );
    const view = await opened();
    listNotebooks.mockResolvedValue([
      notebook({ saved_at: "2026-09-22T11:00:00Z", lab: lab({ status: "Stopped" }) }),
    ]);

    await userEvent.setup().click(view.getByRole("button", { name: "Save and Close" }));

    await waitFor(() => expect(closeNotebook).toHaveBeenCalledWith(RUN_ID, "nb-1"));
    await waitFor(() => expect(view.container.querySelector("iframe")).toBeNull());
    await waitFor(() => expect(view.getByRole("button", { name: "Open Notebook 1" })).toBeTruthy());
    expect(view.getByRole("button", { name: "Create QuixLab notebook" })).toBeTruthy();
  });

  it("keeps the frame when the save is refused, so nothing is lost", async () => {
    closeNotebook.mockRejectedValue(new ApiError(503, "the notebook could not be saved", "storage_unreachable"));
    const view = await opened();

    await userEvent.setup().click(view.getByRole("button", { name: "Save and Close" }));

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("could not be saved");
    expect(view.container.querySelector("iframe")).not.toBeNull();
  });

  it("opens the whole run in a tab, with no credential and no opener", async () => {
    const opens: unknown[][] = [];
    const open = vi.spyOn(window, "open").mockImplementation((...args: unknown[]) => {
      opens.push(args);
      return null;
    });
    const view = await opened();
    await waitFor(() => view.getByRole("button", { name: /Open in a tab/ }));

    await userEvent.setup().click(view.getByRole("button", { name: /Open in a tab/ }));

    expect(opens).toHaveLength(1);
    expect(opens[0][0]).toBe(LAB_ORIGIN);
    expect(String(opens[0][2])).toContain("noopener");
    open.mockRestore();
  });
});
