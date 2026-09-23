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

/* The panel frames this viewer's own lab on one of the run's notebooks. */
const { closeNotebook, getNotebookLab, listNotebooks, openNotebook } = vi.hoisted(() => ({
  closeNotebook: vi.fn(),
  getNotebookLab: vi.fn(),
  listNotebooks: vi.fn(),
  openNotebook: vi.fn(),
}));
vi.mock("@/lib/api/run-quixlab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/run-quixlab")>()),
  closeNotebook,
  getNotebookLab,
  listNotebooks,
  openNotebook,
}));

vi.mock("@/lib/quixlab-ready", () => ({ waitForLab: vi.fn(() => Promise.resolve(true)) }));

import { QuixLabPanel } from "@/components/screens/run-detail/quixlab-panel";
import type { Notebook, RunQuixLab } from "@/lib/api/run-quixlab";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setQuixLabUrl } from "@/lib/quixlab";

const RUN_ID = "RUN-2026-0042";
const ORIGIN = "https://tm-lab-ana-run42.dev.quix.io";
const EMBED_URL = `${ORIGIN}?isIframe=true&theme=light`;

const lab: RunQuixLab = {
  id: "dep-lab",
  name: "tm-lab-ana-run42",
  status: "Running",
  url: ORIGIN,
  notebook: `blob://ws/quixlab-runs/${RUN_ID}/nb-1/analysis.py`,
  created: false,
};
const notebook: Notebook = {
  notebook_id: "nb-1",
  run_id: RUN_ID,
  name: "Notebook 1",
  created_by: "Ana",
  created_at: "2026-09-22T09:00:00Z",
  saved_at: null,
  lab: { ...lab, status: "Stopped" },
};

function withClient(node: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  listNotebooks.mockReset();
  openNotebook.mockReset();
  getNotebookLab.mockReset();
  closeNotebook.mockReset();
  listNotebooks.mockResolvedValue([notebook]);
  openNotebook.mockResolvedValue({ ...notebook, lab });
  getNotebookLab.mockResolvedValue(lab);
  closeNotebook.mockResolvedValue({ ...notebook, saved_at: "2026-09-22T10:00:00Z", lab: { ...lab, status: "Stopping" } });
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
  await user.click(await view.findByRole("button", { name: "Open Notebook 1" }));
  const frame = view.container.querySelector("iframe");
  if (frame === null) throw new Error("the frame did not render");
  await waitFor(() => expect(frame.getAttribute("src")).toBe(EMBED_URL));
  return { user, view, frame };
}

/** The panel element itself — the one that claims the content area. */
const panel = (view: ReturnType<typeof render>) =>
  view.container.firstElementChild as HTMLElement;

describe("an open notebook takes the whole content area", () => {
  it("offers no expand control: there is no small mode to leave", async () => {
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));

    await view.findByRole("button", { name: "Open Notebook 1" });
    expect(view.queryByRole("button", { name: /the QuixLab frame$/ })).toBeNull();
    expect(panel(view).className).not.toContain("fixed");
  });

  it("opens full size at once, the height of the viewport", async () => {
    const { view } = await embed();

    // `fixed` + `bottom-0` is the viewport's own height, never a pixel count.
    const className = panel(view).className;
    expect(className).toContain("fixed");
    expect(className).toContain("bottom-0");
    expect(className).toContain("top-[52px]");
    expect(view.queryByRole("button", { name: /the QuixLab frame$/ })).toBeNull();
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

  it("gives the content area back on Save and Close", async () => {
    const { user, view } = await embed();
    expect(panel(view).className).toContain("fixed");

    await user.click(view.getByRole("button", { name: "Save and Close" }));

    await waitFor(() => expect(panel(view).className).not.toContain("fixed"));
    expect(view.container.querySelector("iframe")).toBeNull();
  });
});
