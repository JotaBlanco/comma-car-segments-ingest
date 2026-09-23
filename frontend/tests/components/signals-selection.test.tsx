/**
 * Picking signals on the Signals tab, and sending that pick to QuixLab.
 *
 * The two screens are cousins: `RunDetailScreen` owns the list, the Signals
 * tab writes it and the QuixLab frame reads it. The harness below holds the
 * list exactly as that screen holds it, so these tests prove the wiring and
 * not one component in isolation.
 *
 * The run holds 261 signals and a page holds 20, so "every row on this page"
 * is never "the whole run". That gap is the point of half of this file.
 */
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileSignal } from "@/types";

const RUN_ID = "TAS-90001";
const ORIGIN = "https://quixlab-dep1.dev.quix.io";
/** The top of the real band: 261 signals, over the default page of 20. */
const SIGNAL_COUNT = 261;
const PAGE_SIZE = 20;

const names = Array.from(
  { length: SIGNAL_COUNT },
  (_, index) => `Signal_${index.toString().padStart(3, "0")}`,
);

const row = (name: string): FileSignal => ({
  name,
  unit: "°C",
  unit_source: "embedded",
  rate_hz: 10,
  dtype: "float64",
  stats: { min: 1, max: 2, mean: 1.5, std: 0.5 },
});

// The stub pages the way the route pages, so the tab's own page and page size
// decide what the table holds. A stub that ignores them proves nothing.
vi.mock("@/lib/hooks", () => ({
  usePageTitle: () => undefined,
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useSignalFacets: () => ({
    data: { units: [], rates: [], rigs: [] },
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
  useRunSignals: (_runId: string, params: { page?: number; page_size?: number }) => {
    const page = params.page ?? 1;
    const pageSize = params.page_size ?? PAGE_SIZE;
    const start = (page - 1) * pageSize;
    return {
      data: {
        items: names.slice(start, start + pageSize).map(row),
        total: names.length,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(names.length / pageSize),
      },
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    };
  },
}));

import { SignalsTab } from "@/components/screens/run-detail/signals-tab";
import { QuixLabFrame } from "@/components/shared/quixlab-frame";
import { setActivePortalToken } from "@/lib/portal/token-store";
import type { QuixLabInstance } from "@/lib/quixlab";

const lab: QuixLabInstance = {
  id: "dep-1",
  name: "QuixLab shared",
  kind: "deployment",
  status: "Running",
  url: ORIGIN,
  embed_url: `${ORIGIN}?isIframe=true`,
  origin: ORIGIN,
};

/**
 * The tab and the frame under one owner, the way `RunDetailScreen` owns them.
 * `withFrame` off renders the tab alone, for the picking tests.
 */
function Harness({ withFrame = false }: { withFrame?: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <>
      <SignalsTab
        runId={RUN_ID}
        signalCount={SIGNAL_COUNT}
        selected={picked}
        onSelectedChange={setPicked}
      />
      {withFrame && (
        <QuixLabFrame embedUrl={lab.embed_url} origin={lab.origin} runId={RUN_ID} signals={picked} />
      )}
    </>
  );
}

const box = (name: string) => screen.getByRole("checkbox", { name });
const rowBox = (signal: string) => box(`Select ${signal}`);
const pageBox = () => box("Select every signal on this page");
const summary = () => screen.getByRole("group", { name: "Signals picked for QuixLab" });

/** Post a message the way a browser posts one: the browser sets the origin. */
function fire(data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: ORIGIN }));
  });
}

/** Render the harness with a frame, and watch every message the frame posts. */
async function mountBoth() {
  setActivePortalToken("token-one");
  const view = render(<Harness withFrame />);
  const frame = view.container.querySelector("iframe");
  if (frame === null) throw new Error("the frame did not render");
  await waitFor(() => expect(frame.getAttribute("src")).toBe(`${lab.embed_url}&theme=light`));

  const child = frame.contentWindow;
  if (child === null) throw new Error("the frame has no child window");
  const posted: unknown[] = [];
  vi.spyOn(child, "postMessage").mockImplementation(((message: unknown) => {
    posted.push(message);
  }) as typeof child.postMessage);

  return { view, frame, posted };
}

describe("picking signals on the Signals tab", () => {
  it("picks one signal from its own row, and counts it", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(summary()).toHaveTextContent(
      "No signal picked. QuixLab opens the whole run. Tick single rows to send only those signals.",
    );

    await user.click(rowBox("Signal_003"));

    expect(rowBox("Signal_003")).toBeChecked();
    expect(rowBox("Signal_004")).not.toBeChecked();
    expect(summary()).toHaveTextContent("1 signal picked for QuixLab.");
  });

  it("picks every row on the page from the header, and unpicks them again", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(pageBox());

    expect(summary()).toHaveTextContent(`${PAGE_SIZE} signals picked for QuixLab.`);
    expect(rowBox("Signal_000")).toBeChecked();
    expect(rowBox("Signal_019")).toBeChecked();
    expect(pageBox()).toBeChecked();

    await user.click(pageBox());

    expect(summary()).toHaveTextContent(
      "No signal picked. QuixLab opens the whole run. Tick single rows to send only those signals.",
    );
    expect(rowBox("Signal_000")).not.toBeChecked();
  });

  it("reads mixed while only some rows on the page are picked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(rowBox("Signal_003"));

    expect(pageBox()).toHaveAttribute("aria-checked", "mixed");
  });

  it("empties the whole pick with Clear", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(rowBox("Signal_003"));
    await user.click(rowBox("Signal_007"));
    expect(summary()).toHaveTextContent("2 signals picked for QuixLab.");

    await user.click(within(summary()).getByRole("button", { name: "Clear" }));

    expect(summary()).toHaveTextContent(
      "No signal picked. QuixLab opens the whole run. Tick single rows to send only those signals.",
    );
    expect(rowBox("Signal_003")).not.toBeChecked();
  });

  it("says that one page is not the whole run", () => {
    render(<Harness />);

    // 261 signals over a page of 20. The header box picks 20 of them, and
    // the tab must never let that read as "the whole run is picked".
    expect(summary()).toHaveTextContent(
      "This page holds 20 of 261 signals. The box in the header picks this page only.",
    );
  });

  it("gives every checkbox a real name", () => {
    render(<Harness />);

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(PAGE_SIZE + 1);
    for (const element of boxes) {
      const name = element.getAttribute("aria-label") ?? "";
      expect(name.trim().length).toBeGreaterThan(0);
    }
    expect(boxes[0].getAttribute("aria-label")).toBe("Select every signal on this page");
  });
});

describe("the pick reaches the QuixLab frame", () => {
  it("sends the run alone while nothing is picked", async () => {
    const { posted } = await mountBoth();

    fire({ type: "REQUEST_TM_IMPORT" });

    expect(posted).toHaveLength(1);
    // No `signals` key at all — byte for byte the message this frame always sent.
    expect(posted[0]).toEqual({ type: "TM_IMPORT", runId: RUN_ID });
    expect(Object.keys(posted[0] as object)).toEqual(["type", "runId"]);
  });

  it("sends one picked signal by name", async () => {
    const user = userEvent.setup();
    const { posted } = await mountBoth();

    await user.click(rowBox("Signal_003"));
    fire({ type: "REQUEST_TM_IMPORT" });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ type: "TM_IMPORT", runId: RUN_ID, signals: ["Signal_003"] });
  });

  it("sends several picked signals, in the order a person picked them", async () => {
    const user = userEvent.setup();
    const { posted } = await mountBoth();

    await user.click(rowBox("Signal_007"));
    await user.click(rowBox("Signal_003"));
    fire({ type: "REQUEST_TM_IMPORT" });

    expect(posted[0]).toEqual({
      type: "TM_IMPORT",
      runId: RUN_ID,
      signals: ["Signal_007", "Signal_003"],
    });
  });

  it("answers with the pick on screen, not the pick it mounted with", async () => {
    const user = userEvent.setup();
    const { posted } = await mountBoth();

    fire({ type: "REQUEST_TM_IMPORT" });
    await user.click(rowBox("Signal_003"));
    fire({ type: "REQUEST_TM_IMPORT" });

    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual({ type: "TM_IMPORT", runId: RUN_ID });
    expect(posted[1]).toEqual({ type: "TM_IMPORT", runId: RUN_ID, signals: ["Signal_003"] });
  });

  it("keeps the frame loaded when the pick changes", async () => {
    const user = userEvent.setup();
    const { frame, view } = await mountBoth();

    await user.click(rowBox("Signal_003"));

    // The same element, and the address set once. A reload would drop the
    // QuixLab session the token handshake just bought.
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(`${lab.embed_url}&theme=light`);
  });

  it("drops a list QuixLab would refuse, and says so", async () => {
    // 501 names is one over the cap. The frame opens the whole run rather
    // than post a list that answers 400, and it never truncates the list.
    const tooMany = Array.from({ length: 501 }, (_, index) => `Over_${index}`);
    setActivePortalToken("token-one");
    const view = render(
      <QuixLabFrame embedUrl={lab.embed_url} origin={lab.origin} runId={RUN_ID} signals={tooMany} />,
    );
    const frame = view.container.querySelector("iframe");
    if (frame === null) throw new Error("the frame did not render");
    await waitFor(() => expect(frame.getAttribute("src")).toBe(`${lab.embed_url}&theme=light`));

    const child = frame.contentWindow;
    if (child === null) throw new Error("the frame has no child window");
    const posted: unknown[] = [];
    vi.spyOn(child, "postMessage").mockImplementation(((message: unknown) => {
      posted.push(message);
    }) as typeof child.postMessage);

    fire({ type: "REQUEST_TM_IMPORT" });

    expect(posted).toEqual([{ type: "TM_IMPORT", runId: RUN_ID }]);
    expect(view.getByRole("alert").textContent).toContain("501");
  });
});
