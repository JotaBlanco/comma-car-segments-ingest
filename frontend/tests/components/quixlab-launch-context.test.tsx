import type React from "react";
/**
 * Every QuixLab launch control carries its context, or it does not exist.
 *
 * QuixLab opens one run. Its import surface takes a run id and signal names,
 * and nothing else. Until 26 Aug 2026 three header buttons passed their click
 * event into `openQuixLab(url?, runId?)`, the event fell through the string
 * guard, and QuixLab opened bare. This file pins the repair:
 *
 *   1. the run detail header passes its run id;
 *   2. the file detail header passes the run its file belongs to, and an
 *      orphan file shows no control at all;
 *   3. the signal detail screen shows no control at all. A signal spans many
 *      runs, so "open this signal" names no one run. The statistics rows
 *      link to the runs, and the run screen carries the control.
 *
 * The sidebar control stays context-free on purpose: it is the global entry,
 * and the module fallback is its design.
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
   instead, the way `new-tab-marks.test.tsx` does, so each screen renders its
   real controls with real values. */
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
    /* An orphan file asks for run "" — the real hook disables the query,
       so the mock answers no data instead of throwing. */
    useRun: (runId: string) => (runId === "" ? ok(undefined) : ok(db.getRun(state(), runId))),
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

const { listQuixLabs, getLakehouseUrl } = vi.hoisted(() => ({
  listQuixLabs: vi.fn(),
  getLakehouseUrl: vi.fn(),
}));
vi.mock("@/lib/api/integrations", () => ({ listQuixLabs, getLakehouseUrl }));

/* The run detail control no longer opens a shared QuixLab: it opens the run's
   newest notebook in a lab of this viewer's own, making the first when there is
   none. The context it must carry is the run id it asks with. */
const { createNotebook, getNotebookLab, listNotebooks, openNotebook } = vi.hoisted(() => ({
  createNotebook: vi.fn(),
  getNotebookLab: vi.fn(),
  listNotebooks: vi.fn(),
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
import { RunDetailScreen } from "@/components/screens/run-detail/run-detail-screen";
import { SignalDetailScreen } from "@/components/screens/signals/signal-detail-screen";
import { getDb, listFiles, listRuns, listSignals } from "@/lib/mock/db";
import { setQuixLabPortalUrl, setQuixLabUrl } from "@/lib/quixlab";

const PAGE = { page: 1, pageSize: 100 };
const db = getDb();
const run = listRuns(db, {}, PAGE).items[0];
const linkedFile = listFiles(db, {}, PAGE).items.find((f) => f.run_id !== null)!;
const orphanFile = listFiles(db, { unlinked: true }, PAGE).items[0];
const signal = listSignals(db, {}, PAGE).items[0];

const QUIXLAB = "https://quixlab-abc123.dev.quix.io";
const LAUNCH = /Open in QuixLab/;

let opened: string[];
let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createNotebook.mockReset();
  getNotebookLab.mockReset();
  listNotebooks.mockReset();
  openNotebook.mockReset();
  // The ordinary "this run has no notebook yet".
  listNotebooks.mockResolvedValue([]);
  listQuixLabs.mockReset();
  listQuixLabs.mockResolvedValue([]);
  getLakehouseUrl.mockReset();
  getLakehouseUrl.mockResolvedValue("");
  localStorage.clear();
  setQuixLabUrl(QUIXLAB);
  opened = [];
  open = vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
});

afterEach(() => {
  open.mockRestore();
  setQuixLabUrl(null);
  setQuixLabPortalUrl(null);
});

/* The run screen's QuixLab panel invalidates the results queries on Save and Close,
   so a render of the screen needs a client to invalidate against. */
function withClient(node: React.ReactElement): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe("the run detail launch control", () => {
  it("asks for a lab for the run on screen, and sends the tab to it", async () => {
    const win = {
      opener: {} as unknown,
      closed: false,
      location: { replace: vi.fn() },
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
    };
    open.mockImplementation((url?: string | URL) => {
      opened.push(String(url));
      return win as unknown as Window;
    });
    createNotebook.mockResolvedValue({
      notebook_id: "nb-1",
      run_id: run.run_id,
      name: "Notebook 1",
      created_by: "Ana",
      created_at: "2026-09-22T09:00:00Z",
      saved_at: null,
      lab: {
        id: "dep-lab",
        name: "tm-lab-a",
        status: "Running",
        url: "https://tm-lab-a.dev.quix.io",
        notebook: `blob://ws/quixlab-runs/${run.run_id}/nb-1/analysis.py`,
        created: true,
      },
    });
    render(withClient(<RunDetailScreen runId={run.run_id} />));

    await userEvent.setup().click(screen.getAllByRole("button", { name: LAUNCH })[0]);

    await vi.waitFor(() => expect(win.location.replace).toHaveBeenCalled());
    expect(listNotebooks).toHaveBeenCalledWith(run.run_id);
    expect(createNotebook).toHaveBeenCalledWith(run.run_id);
    expect(openNotebook).not.toHaveBeenCalled();
    expect(win.location.replace).toHaveBeenCalledWith("https://tm-lab-a.dev.quix.io");
    // The tab is claimed on the CLICK, with no address: the lab does not exist
    // yet, and a `window.open` after the await would be blocked.
    expect(opened).toEqual([""]);
  });
});

describe("the file detail launch control", () => {
  it("carries the run the file belongs to", async () => {
    render(<FileDetailScreen fileId={linkedFile.file_id} />);

    await userEvent.setup().click(screen.getByRole("button", { name: LAUNCH }));

    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]).searchParams.get("run")).toBe(linkedFile.run_id);
  });

  it("does not exist on an orphan file, which names no run", () => {
    expect(orphanFile.run_id).toBeNull();

    render(<FileDetailScreen fileId={orphanFile.file_id} />);

    expect(screen.queryByRole("button", { name: LAUNCH })).toBeNull();
  });
});

describe("the signal detail screen", () => {
  it("holds no launch control, because a signal names no one run", () => {
    render(<SignalDetailScreen name={signal.name} />);

    /* The screen rendered — its other header action is there. */
    expect(screen.getByRole("button", { name: /Edit catalog entry/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LAUNCH })).toBeNull();
  });
});
