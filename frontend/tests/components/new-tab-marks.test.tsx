/**
 * Every control that opens a new tab carries the external-link mark, and a
 * control that stays in the page never does.
 *
 * The mark has two parts, and each part serves one audience:
 *
 *   - the icon serves the eye. It TRAILS the label, because it states what
 *     the activation does. The leading slot of a nav row holds the row's own
 *     identity icon;
 *   - the words serve the screen reader. The icon is `aria-hidden`, so the
 *     accessible name must say "(opens in a new tab)" in words.
 *
 * The sidebar's QuixLab and Lakehouse rows lead to `/quixlab` and `/lakehouse`
 * now (architecture.md "What changed") and carry no mark: they frame their
 * target in the content area, they do not leave it. The Swagger footer link
 * still opens a tab and still carries the mark — it is the only `target=
 * "_blank"` left in the sidebar.
 *
 * The file renders every screen that holds such a control, and it also proves
 * two negatives: a control that stays in the page gets no mark, and the
 * collapsed rail shows no second icon on a row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
    // The run strip counts the issues itself now; none in these tests.
    useRunSnippets: () => ok({ snippets: [] }),
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

/* The panel lists the run's notebooks and frames one in this viewer's own lab.
   It needs an open one to have an "Open in a tab" control at all. */
const { createNotebook, getNotebookLab, listNotebooks, openNotebook } = vi.hoisted(() => ({
  createNotebook: vi.fn(),
  getNotebookLab: vi.fn(),
  listNotebooks: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
  openNotebook: vi.fn(),
}));
vi.mock("@/lib/api/run-quixlab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/run-quixlab")>()),
  createNotebook,
  getNotebookLab,
  listNotebooks,
  openNotebook,
}));

vi.mock("@/lib/quixlab-ready", () => ({ waitForLab: vi.fn(() => Promise.resolve(true)) }));

import { FileDetailScreen } from "@/components/screens/files/file-detail-screen";
import { QuixLabPanel } from "@/components/screens/run-detail/quixlab-panel";
import { RunDetailScreen } from "@/components/screens/run-detail/run-detail-screen";
import { Sidebar } from "@/components/shell/sidebar";
import { getDb, listFiles, listRuns } from "@/lib/mock/db";
import { setQuixLabPortalUrl, setQuixLabUrl, type QuixLabInstance } from "@/lib/quixlab";

function withClient(node: React.ReactElement): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

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
  it("marks the Swagger footer link, after the label", () => {
    render(<Sidebar />);
    const control = screen.getByRole("link", {
      name: `Swagger API reference v1 ${SUFFIX}`,
    });
    expectMarked(control);
  });

  it("carries no mark on the QuixLab row: it frames the page, it does not leave it", async () => {
    render(<Sidebar />);
    const control = await screen.findByRole("link", { name: "QuixLab" });
    expect(mark(control)).toBeNull();
    expect(control.textContent).not.toContain(SUFFIX);
  });

  it("carries no mark on the Lakehouse row: it frames the page, it does not leave it", async () => {
    render(<Sidebar />);
    const control = await screen.findByRole("link", { name: "Lakehouse" });
    expect(mark(control)).toBeNull();
    expect(control.textContent).not.toContain(SUFFIX);
  });

  it("hides the Swagger footer link on the collapsed rail", async () => {
    render(<Sidebar />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Collapse sidebar" }));

    // The footer has no room on the rail, so it disappears with it — the
    // marked link never sits half-collapsed with just its icon showing.
    expect(
      screen.queryByRole("link", { name: `Swagger API reference v1 ${SUFFIX}` }),
    ).toBeNull();
  });
});

describe("the Open in QuixLab headers", () => {
  it("marks the run detail control", () => {
    render(withClient(<RunDetailScreen runId={run.run_id} />));
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
  it("marks Open in a tab, and leaves Open and Create without a mark", async () => {
    const lab = {
      id: "dep-lab",
      name: "tm-lab-ana",
      status: "Running",
      url: "https://tm-lab-ana.dev.quix.io",
      notebook: `blob://ws/quixlab-runs/${run.run_id}/nb-1/analysis.py`,
      created: false,
    };
    const notebook = {
      notebook_id: "nb-1",
      run_id: run.run_id,
      name: "Notebook 1",
      created_by: "Ana",
      created_at: "2026-09-22T09:00:00Z",
      saved_at: null,
      lab,
    };
    listNotebooks.mockResolvedValue([notebook]);
    openNotebook.mockResolvedValue(notebook);
    const view = render(withClient(<QuixLabPanel runId={run.run_id} />));

    /* "Open" and "Create" frame QuixLab inside this screen. They open no tab,
       so they must not carry the mark — the mark has one meaning. */
    const open = await view.findByRole("button", { name: "Open Notebook 1" });
    expect(mark(open)).toBeNull();
    expect(open.textContent).not.toContain(SUFFIX);
    const create = view.getByRole("button", { name: "Create QuixLab notebook" });
    expect(mark(create)).toBeNull();

    await userEvent.setup().click(open);
    await view.findByRole("button", { name: `Open in a tab ${SUFFIX}` });

    expectMarked(view.getByRole("button", { name: `Open in a tab ${SUFFIX}` }));
  });
});
