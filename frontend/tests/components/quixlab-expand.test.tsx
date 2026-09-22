/**
 * Giving the embedded QuixLab room.
 *
 * The Portal frames the Test Manager, and the Test Manager frames QuixLab, so
 * QuixLab renders two boxes deep and it renders small. Expanded lifts the
 * panel over the content area.
 *
 * The rule this file exists to hold: **expanding must not reload the frame.**
 * The token handshake buys QuixLab an 8-hour session, and a reload throws it
 * away. So the test compares the iframe NODE across a toggle, not its markup.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";

/* The panel frames this viewer's own lab for this run, not a picked instance. */
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
import type { RunQuixLab } from "@/lib/api/run-quixlab";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setQuixLabUrl } from "@/lib/quixlab";

const RUN_ID = "RUN-2026-0042";
const ORIGIN = "https://tm-lab-ana-run42.dev.quix.io";
const EMBED_URL = `${ORIGIN}?isIframe=true`;

const lab: RunQuixLab = {
  id: "dep-lab",
  name: "tm-lab-ana-run42",
  status: "Running",
  url: ORIGIN,
  notebook: `blob://ws/quixlab-runs/${RUN_ID}/analysis.py`,
  created: false,
};

function withClient(node: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  createRunQuixLab.mockReset();
  getRunQuixLab.mockReset();
  getRunQuixLab.mockResolvedValue(lab);
  createRunQuixLab.mockResolvedValue(lab);
  closeRunQuixLab.mockReset();
  closeRunQuixLab.mockResolvedValue({ ...lab, status: "Stopping", saved_result_id: "res-1" });
  setActivePortalToken("token-one");
  setQuixLabUrl(null);
});

afterEach(() => {
  setActivePortalToken(null);
  setQuixLabUrl(null);
  vi.restoreAllMocks();
});

/** Mount the panel and open the frame, the way a person opens it. */
async function embed() {
  const user = userEvent.setup();
  const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));
  await user.click(await view.findByRole("button", { name: "Open QuixLab notebook" }));
  const frame = view.container.querySelector("iframe");
  if (frame === null) throw new Error("the frame did not render");
  await waitFor(() => expect(frame.getAttribute("src")).toBe(EMBED_URL));
  return { user, view, frame };
}

const expandControl = (view: ReturnType<typeof render>) =>
  view.getByRole("button", { name: /the QuixLab frame$/ });

/** The panel element itself — the one that claims the content area. */
const panel = (view: ReturnType<typeof render>) =>
  view.container.firstElementChild as HTMLElement;

describe("the embedded frame takes more room", () => {
  it("offers no expand control before a frame exists", async () => {
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));

    await view.findByRole("button", { name: "Open QuixLab notebook" });
    expect(view.queryByRole("button", { name: /the QuixLab frame$/ })).toBeNull();
  });

  it("names the control, and the name says which way it goes", async () => {
    const { user, view } = await embed();

    const control = expandControl(view);
    expect(control).toHaveAccessibleName("Expand the QuixLab frame");
    expect(control).toHaveAttribute("aria-pressed", "false");

    await user.click(control);

    expect(expandControl(view)).toHaveAccessibleName("Collapse the QuixLab frame");
    expect(expandControl(view)).toHaveAttribute("aria-pressed", "true");
  });

  it("gives the panel the content area, and the height of the viewport", async () => {
    const { user, view } = await embed();

    expect(panel(view).className).not.toContain("fixed");

    await user.click(expandControl(view));

    // `fixed` + `bottom-0` is the viewport's own height, never a pixel count.
    const className = panel(view).className;
    expect(className).toContain("fixed");
    expect(className).toContain("bottom-0");
    expect(className).toContain("top-[52px]");
  });

  it("keeps the SAME frame node across a toggle, so the session survives", async () => {
    const { user, view, frame } = await embed();

    await user.click(expandControl(view));
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(EMBED_URL);

    await user.click(expandControl(view));
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(EMBED_URL);
    // Never a sandbox: QuixLab needs same-origin storage for its session cookie.
    expect(frame.hasAttribute("sandbox")).toBe(false);
  });

  it("keeps the SAME frame node when the signal pick appears above it", async () => {
    // The pick adds a line between the header and the frame. React keeps the
    // frame's slot, so the node survives — a moved frame would reload QuixLab.
    const { view, frame } = await embed();

    view.rerender(withClient(<QuixLabPanel runId={RUN_ID} signals={["Signal_003", "Signal_007"]} />));

    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(EMBED_URL);
    expect(view.container.textContent).toContain("“Open in a tab” opens the whole run");
  });

  it("leaves the expanded panel on Escape", async () => {
    const { user, view } = await embed();

    await user.click(expandControl(view));
    expect(panel(view).className).toContain("fixed");

    await user.keyboard("{Escape}");

    expect(panel(view).className).not.toContain("fixed");
    expect(expandControl(view)).toHaveAccessibleName("Expand the QuixLab frame");
  });

  it("drops the expanded panel when a person closes the frame", async () => {
    const { user, view } = await embed();

    await user.click(expandControl(view));
    await user.click(view.getByRole("button", { name: "Save and Close" }));

    expect(panel(view).className).not.toContain("fixed");
    expect(view.container.querySelector("iframe")).toBeNull();
  });
});
