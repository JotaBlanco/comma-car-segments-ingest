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
import { act, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { listQuixLabs } = vi.hoisted(() => ({ listQuixLabs: vi.fn() }));
vi.mock("@/lib/api/integrations", () => ({ listQuixLabs }));

import { QuixLabPanel } from "@/components/screens/run-detail/quixlab-panel";
import { QuixLabFrame } from "@/components/shared/quixlab-frame";
import { ApiError } from "@/lib/api/client";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setQuixLabUrl, type QuixLabInstance } from "@/lib/quixlab";

const RUN_ID = "RUN-2026-0042";
const SHARED_ORIGIN = "https://quixlab-dep1.dev.quix.io";
const SESSION_ORIGIN = "https://quixlab-sess9.dev.quix.io";

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

const devSession = instance({
  id: "sess-9",
  name: "Ana's lab",
  kind: "devsession",
  status: "Running",
  url: SESSION_ORIGIN,
  embed_url: `${SESSION_ORIGIN}?isIframe=true`,
  origin: SESSION_ORIGIN,
});

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

beforeEach(() => {
  listQuixLabs.mockReset();
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

describe("the picker", () => {
  it("names both kinds apart, and defaults to the shared deployment", async () => {
    listQuixLabs.mockResolvedValue([instance(), devSession]);
    const view = render(<QuixLabPanel runId={RUN_ID} />);

    // The closed trigger shows the default pick: the shared deployment.
    const trigger = await view.findByLabelText("QuixLab");
    expect(trigger).toHaveTextContent("QuixLab shared (Deployment) - Running");

    await userEvent.setup().click(trigger);
    const groups = await view.findAllByRole("group");
    expect(groups).toHaveLength(2);
    expect(view.getByRole("group", { name: "Deployments" })).toHaveTextContent(
      "(Deployment)",
    );
    expect(view.getByRole("group", { name: "Dev sessions" })).toHaveTextContent(
      "(Dev session)",
    );
  });

  it("shows a stopped dev session, and refuses to let a person pick it", async () => {
    listQuixLabs.mockResolvedValue([
      instance(),
      { ...devSession, status: "Stopped" },
    ]);
    const view = render(<QuixLabPanel runId={RUN_ID} />);
    const user = userEvent.setup();

    const trigger = await view.findByLabelText("QuixLab");
    await user.click(trigger);
    const stopped = await view.findByRole("option", { name: /Ana's lab.*Stopped/ });
    expect(stopped).toHaveAttribute("aria-disabled", "true");

    // A click on the stopped entry changes nothing: the pick stays put.
    await user.click(stopped);
    expect(trigger).toHaveTextContent("QuixLab shared (Deployment) - Running");
  });

  it("falls back to the configured QuixLab when the list is empty", async () => {
    listQuixLabs.mockResolvedValue([]);
    setQuixLabUrl(SHARED_ORIGIN);
    const view = render(<QuixLabPanel runId={RUN_ID} />);

    // The configured fallback has no status, so no state joins the label.
    const trigger = await view.findByLabelText("QuixLab");
    expect(trigger).toHaveTextContent("QuixLab (Deployment)");
    // An empty list is an ordinary answer, so nothing on screen reads as a fault.
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("reads a 503 as an outage, and still offers the fallback", async () => {
    listQuixLabs.mockRejectedValue(
      new ApiError(503, "the Quix platform did not answer", "platform_unavailable"),
    );
    setQuixLabUrl(SHARED_ORIGIN);
    const view = render(<QuixLabPanel runId={RUN_ID} />);

    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("did not answer");
    expect(view.getByLabelText("QuixLab")).toHaveTextContent("QuixLab (Deployment)");
  });

  it("shows nothing at all when no QuixLab resolves", async () => {
    listQuixLabs.mockResolvedValue([]);
    const view = render(<QuixLabPanel runId={RUN_ID} />);

    await waitFor(() => expect(listQuixLabs).toHaveBeenCalled());
    expect(view.container.textContent).toBe("");
  });
});

describe("the two actions", () => {
  it("opens the picked QuixLab in a tab, with no credential and no opener", async () => {
    const opened: string[] = [];
    const open = vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
    listQuixLabs.mockResolvedValue([instance(), devSession]);
    const view = render(<QuixLabPanel runId={RUN_ID} />);

    await view.findByLabelText("QuixLab");
    await userEvent.setup().click(view.getByRole("button", { name: "Open in a tab (opens in a new tab)" }));

    expect(opened).toEqual([`${SHARED_ORIGIN}?open=analysis&kind=notebook&run=${RUN_ID}`]);
    expect(open).toHaveBeenCalledWith(expect.any(String), "_blank", "noopener,noreferrer");
  });

  it("opens the PORTAL embedded view when the Portal named the deployment", async () => {
    /* The tab must land inside the Portal, not on the raw deployment host.
       The Portal frames the deployment, sets `isIframe=true` itself and copies
       every extra query parameter into the frame, so the deep link and the run
       id survive the hop. */
    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
    const portal =
      "https://portal.dev.quix.io/pipeline/deployments/dep-1/embedded?workspace=ws-demo";
    listQuixLabs.mockResolvedValue([instance({ portal_embedded_url: portal })]);
    const view = render(<QuixLabPanel runId={RUN_ID} />);

    await view.findByLabelText("QuixLab");
    await userEvent.setup().click(view.getByRole("button", { name: "Open in a tab (opens in a new tab)" }));

    expect(opened).toEqual([`${portal}&open=analysis&kind=notebook&run=${RUN_ID}`]);
    const query = new URL(opened[0]).searchParams;
    expect(query.get("workspace")).toBe("ws-demo");
    expect(query.get("run")).toBe(RUN_ID);
  });

  it("keeps the direct URL for a dev session, which has no deployment page", async () => {
    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
    listQuixLabs.mockResolvedValue([devSession]);
    const view = render(<QuixLabPanel runId={RUN_ID} />);

    const trigger = await view.findByLabelText("QuixLab");
    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(await view.findByRole("option", { name: /Ana's lab/ }));
    await user.click(view.getByRole("button", { name: "Open in a tab (opens in a new tab)" }));

    expect(opened).toEqual([`${SESSION_ORIGIN}?open=analysis&kind=notebook&run=${RUN_ID}`]);
  });

  it("embeds the picked QuixLab, and follows the pick when it changes", async () => {
    listQuixLabs.mockResolvedValue([instance(), devSession]);
    const view = render(<QuixLabPanel runId={RUN_ID} />);
    const user = userEvent.setup();

    const trigger = await view.findByLabelText("QuixLab");
    expect(view.container.querySelector("iframe")).toBeNull();

    await user.click(view.getByRole("button", { name: "Embed here" }));
    await waitFor(() =>
      expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe(
        `${SHARED_ORIGIN}?isIframe=true`,
      ),
    );

    // A new pick is a new handshake, so the frame closes rather than keeping a
    // session that belongs to the old origin.
    await user.click(trigger);
    await user.click(await view.findByRole("option", { name: /Ana's lab/ }));
    expect(view.container.querySelector("iframe")).toBeNull();

    await user.click(view.getByRole("button", { name: "Embed here" }));
    await waitFor(() =>
      expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe(
        `${SESSION_ORIGIN}?isIframe=true`,
      ),
    );
  });
});
