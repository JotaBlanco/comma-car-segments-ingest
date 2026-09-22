/**
 * Every control that opens a new tab carries the external-link mark.
 *
 * The mark has two parts, and each part serves one audience:
 *
 *   - the icon serves the eye. It TRAILS the label, because it states what
 *     the activation does. The leading slot of a nav row holds the row's own
 *     identity icon;
 *   - the words serve the screen reader. The icon is `aria-hidden`, so the
 *     accessible name must say "(opens in a new tab)" in words.
 *
 * The file renders every screen that holds such a control, and it also proves
 * two negatives: a control that stays in the page gets no mark, and the
 * collapsed rail shows no second icon on a row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

/* The screens read their data through react-query. Serve the demo database
   instead, the way `no-would-toasts.test.tsx` does, so each screen renders
   its real controls with real values. */
vi.mock("@/lib/hooks", async () => {
  const db = await vi.importActual<typeof import("@/lib/mock/db")>("@/lib/mock/db");
  const page = { page: 1, pageSize: 100 };
  const ok = <T,>(data: T) => ({
    data,
    isPending: false,
    isError: false,
    isSuccess: true,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  });
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    reset: vi.fn(),
  });
  const state = () => db.getDb();
  return {
    usePageTitle: () => undefined,
    useRun: (runId: string) => ok(db.getRun(state(), runId)),
    useRuns: (filters = {}) => ok(db.listRuns(state(), filters, page)),
    useRunFiles: (runId: string) => ok(db.listRunFiles(state(), runId)),
    useRunSignals: (runId: string) => ok(db.listRunSignals(state(), runId, page)),
    useRunJournal: (runId: string) => ok(db.getRunJournal(state(), runId, undefined, page)),
    useRunLineage: (runId: string) => ok(db.getRunLineage(state(), runId)),
    useFile: (fileId: string) => ok(db.getFile(state(), fileId, 200)),
    useFileJournal: (fileId: string) =>
      ok(db.getEntityJournal(state(), "file", fileId, undefined, page)),
    useSignalJournal: (name: string) =>
      ok(db.getEntityJournal(state(), "signal", name, undefined, page)),
    useFiles: (filters = {}) => ok(db.listFiles(state(), filters, page)),
    useFileVersions: () => ok({ items: [], total: 0 }),
    useSignal: (name: string) => ok(db.getSignal(state(), name)),
    useSignals: (filters = {}) => ok(db.listSignals(state(), filters, page)),
    useSignalFacets: () => ok(db.signalFacets(state())),
    useSignalRunStats: (name: string, filters = {}) =>
      ok(db.getSignalRunStats(state(), name, filters, page)),
    useResults: (filters = {}) => ok(db.listResults(state(), filters, page)),
    useWorkOrders: (filters = {}) => ok(db.listWorkOrders(state(), filters, page)),
    useHomeSummary: () => ok(db.getHomeSummary(state())),
    useExploreContext: (runId: string) => ok(db.getExploreContext(state(), runId)),
    useExploreQuery: mutation,
    usePlanningSyncStatus: () => ok(db.getSyncStatus(state())),
    useActor: () => "Test Engineer",
    usePatchRun: mutation,
    usePatchSignal: mutation,
    useFlagInvalid: mutation,
    useClearInvalid: mutation,
    useFlagFileInvalid: mutation,
    useClearFileInvalid: mutation,
    useAddRunNote: mutation,
    useAddJournalNote: mutation,
    useRequestAccess: mutation,
    usePatchFile: mutation,
    useToggleSync: mutation,
    useUploadResult: mutation,
    useFileLifecycle: mutation,
    useRegisterFileVersion: mutation,
  };
});

/* The sidebar asks these two on the mount. The answers decide which Analysis
   rows exist, so this file decides them itself. */
const { listQuixLabs, getLakehouseUrl } = vi.hoisted(() => ({
  listQuixLabs: vi.fn(),
  getLakehouseUrl: vi.fn(),
}));
vi.mock("@/lib/api/integrations", () => ({ listQuixLabs, getLakehouseUrl }));

import { FileDetailScreen } from "@/components/screens/files/file-detail-screen";
import { QuixLabPanel } from "@/components/screens/run-detail/quixlab-panel";
import { RunDetailScreen } from "@/components/screens/run-detail/run-detail-screen";
import { Sidebar } from "@/components/shell/sidebar";
import { getDb, listFiles, listRuns } from "@/lib/mock/db";
import { setQuixLabPortalUrl, setQuixLabUrl, type QuixLabInstance } from "@/lib/quixlab";

const PAGE = { page: 1, pageSize: 100 };
const db = getDb();
const run = listRuns(db, {}, PAGE).items[0];
const file = listFiles(db, {}, PAGE).items[0];

const QUIXLAB = "https://quixlab-abc123.dev.quix.io";
const LAKEHOUSE = "https://portal.dev.quix.io/lakehouse?workspace=quixdev-testmanagerdemo-dev";
const SUFFIX = "(opens in a new tab)";

const instance: QuixLabInstance = {
  id: "dep-1",
  name: "QuixLab shared",
  kind: "deployment",
  status: "Running",
  url: QUIXLAB,
  embed_url: `${QUIXLAB}?isIframe=true`,
  origin: QUIXLAB,
};

/** The one icon of the house: `lucide-react`'s ExternalLink. */
function mark(control: HTMLElement): SVGElement | null {
  return control.querySelector('svg[class*="lucide-external-link"]');
}

/** The control carries the mark: trailing icon, hidden from the reader. */
function expectMarked(control: HTMLElement): void {
  const icon = mark(control);
  expect(icon).not.toBeNull();
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  /* Trailing: the icon is the control's LAST element, after the label. The
     leading slot stays free for the control's own icon. */
  expect(control.lastElementChild).toBe(icon);
}

beforeEach(() => {
  listQuixLabs.mockReset();
  listQuixLabs.mockResolvedValue([instance]);
  getLakehouseUrl.mockReset();
  getLakehouseUrl.mockResolvedValue(LAKEHOUSE);
  localStorage.clear();
  setQuixLabUrl(QUIXLAB);
});

afterEach(() => {
  setQuixLabUrl(null);
  setQuixLabPortalUrl(null);
});

describe("the sidebar new-tab controls", () => {
  it("marks the QuixLab row, after the label", () => {
    render(<Sidebar />);
    const control = screen.getByRole("button", { name: `QuixLab ${SUFFIX}` });
    expectMarked(control);
  });

  it("marks the Lakehouse row, after the label", async () => {
    render(<Sidebar />);
    const control = await screen.findByRole("link", { name: `Lakehouse ${SUFFIX}` });
    expectMarked(control);
  });

  it("marks the Swagger footer link, after the label", () => {
    render(<Sidebar />);
    const control = screen.getByRole("link", {
      name: `Swagger API reference v1 ${SUFFIX}`,
    });
    expectMarked(control);
  });

  it("drops the icon on the collapsed rail, and keeps the words", async () => {
    render(<Sidebar />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Collapse sidebar" }));

    /* One icon per row on the rail. The fact still reaches a screen reader,
       because the words live in the accessible name. */
    const control = screen.getByRole("button", { name: `QuixLab ${SUFFIX}` });
    expect(mark(control)).toBeNull();
  });
});

describe("the Open in QuixLab headers", () => {
  it("marks the run detail control", () => {
    render(<RunDetailScreen runId={run.run_id} />);
    const controls = screen.getAllByRole("button", { name: `Open in QuixLab ${SUFFIX}` });
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expectMarked(control);
    }
  });

  it("marks the file detail control", () => {
    render(<FileDetailScreen fileId={file.file_id} />);
    const control = screen.getByRole("button", { name: `Open in QuixLab ${SUFFIX}` });
    expectMarked(control);
  });

  /* The signal detail screen holds no such control any more. QuixLab opens
     one run, and a signal spans many, so the owner removed the button
     (26 Aug 2026). `quixlab-launch-context.test.tsx` pins the absence. */
});

describe("the QuixLab panel", () => {
  it("marks Open in a tab, and leaves Embed here without a mark", async () => {
    const view = render(<QuixLabPanel runId={run.run_id} />);
    await view.findByLabelText("QuixLab");

    expectMarked(view.getByRole("button", { name: `Open in a tab ${SUFFIX}` }));

    /* "Embed here" frames QuixLab inside this screen. It opens no tab, so it
       must not carry the mark — the mark has one meaning. */
    const embed = view.getByRole("button", { name: "Embed here" });
    expect(mark(embed)).toBeNull();
    expect(embed.textContent).not.toContain(SUFFIX);
  });
});
