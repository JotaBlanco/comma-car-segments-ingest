/**
 * R-04 guard: no control tells the room that a feature is a mock.
 *
 * Six controls called `toast("Would …")`. Four of them were accent-filled
 * primary buttons, so they read as the most important control on the screen.
 * This file guards the six sites and every site a person adds later:
 *
 *   1. it renders each screen that held one, clicks every control, and reads
 *      every toast the screen fired;
 *   2. it reads the source of `components/` and `app/` and fails on any
 *      `toast("Would …")` call, so a seventh site cannot slip in behind a
 *      condition or on a screen this file does not render.
 *
 * Each render runs twice: with no QuixLab URL configured, which is the default,
 * and with a QuixLab URL configured. A hidden control must not hide a
 * placeholder toast.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import userEvent from "@testing-library/user-event";

const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));

// Capture every toast the screens fire. `sonner` renders nothing here.
vi.mock("sonner", () => {
  const record = (message: unknown): string => {
    toasts.push(typeof message === "string" ? message : String(message));
    return "toast-id";
  };
  const toast = Object.assign(record, {
    success: record,
    error: record,
    info: record,
    warning: record,
    message: record,
    loading: record,
    custom: record,
    dismiss: vi.fn(),
    promise: vi.fn(),
  });
  return { toast, Toaster: () => null };
});

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

// The screens read their data through react-query. Serve the demo database
// instead, so each screen renders its real controls with real values.
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
    useFileJournal: (fileId: string) => ok(db.getEntityJournal(state(), "file", fileId, undefined, page)),
    useSignalJournal: (name: string) => ok(db.getEntityJournal(state(), "signal", name, undefined, page)),
    useFiles: (filters = {}) => ok(db.listFiles(state(), filters, page)),
    // The demo database holds no version chain, so the history is empty here.
    useFileVersions: () => ok({ items: [], total: 0 }),
    useSignal: (name: string) => ok(db.getSignal(state(), name)),
    useSignals: (filters = {}) => ok(db.listSignals(state(), filters, page)),
    // The unit autocomplete reads the whole catalog's units (§14b).
    useSignalFacets: () => ok(db.signalFacets(state())),
    useSignalRunStats: (name: string, filters = {}) =>
      ok(db.getSignalRunStats(state(), name, filters, page)),
    useResults: (filters = {}) => ok(db.listResults(state(), filters, page)),
    // The run edit dialog picks a work order from the mirrored list.
    useWorkOrders: (filters = {}) => ok(db.listWorkOrders(state(), filters, page)),
    useHomeSummary: () => ok(db.getHomeSummary(state())),
    // The run detail screen renders the Explore tab, so the mock must answer
    // both explore hooks or the whole screen throws.
    useExploreContext: (runId: string) => ok(db.getExploreContext(state(), runId)),
    useExploreQuery: mutation,
    usePlanningSyncStatus: () => ok(db.getSyncStatus(state())),
    // Every write control reads the actor from the signed-in Portal identity.
    // A name here keeps the controls enabled, so the click loop reaches them.
    useActor: () => "Test Engineer",
    usePatchRun: mutation,
    usePatchSignal: mutation,
    useFlagInvalid: mutation,
    useClearInvalid: mutation,
    // The file detail screen raises and clears a file-level invalid flag.
    // Those two hooks arrived with the file invalid flag and the barrel mock
    // must answer them, or the dialog throws before any click lands.
    useFlagFileInvalid: mutation,
    useClearFileInvalid: mutation,
    useAddRunNote: mutation,
    // The shared Add-note dialog and the file link dialog (TR-003).
    useAddJournalNote: mutation,
    useRequestAccess: mutation,
    usePatchFile: mutation,
    useToggleSync: mutation,
    useUploadResult: mutation,
    useFileLifecycle: mutation,
    useRegisterFileVersion: mutation,
    // The run list's delete dialog announces its outcome to a screen reader.
    // The real hook falls back to a no-op with no provider above it, so a no-op
    // is exactly what the barrel must answer here — without it the dialog
    // throws while rendering and the run detail screen never gets clicked.
    useAnnounce: () => () => undefined,
  };
});

import { FileDetailScreen } from "@/components/screens/files/file-detail-screen";
import { FileSignalsTable } from "@/components/screens/files/file-signals-table";
import { RunDetailScreen } from "@/components/screens/run-detail/run-detail-screen";
import { SignalsTab } from "@/components/screens/run-detail/signals-tab";
import { SignalDetailScreen } from "@/components/screens/signals/signal-detail-screen";
import { Sidebar } from "@/components/shell/sidebar";
import { getDb, getFile, listFiles, listRuns, listSignals } from "@/lib/mock/db";
import { setQuixLabUrl } from "@/lib/quixlab";

/* The hooks barrel is mocked above, so nothing here fetches — but the run
   screen's delete dialog calls `useQueryClient` directly to invalidate the list
   after a delete, and that reads the CONTEXT rather than the barrel. Without a
   provider it throws while rendering, and the click loop below never reaches a
   single control on that screen. A fresh client per render keeps the two
   QuixLab passes independent. */
function renderScreen(element: ReactElement) {
  function Wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(element, { wrapper: Wrapper });
}

const PAGE = { page: 1, pageSize: 100 };
const db = getDb();
const run = listRuns(db, {}, PAGE).items[0];
const file = listFiles(db, {}, PAGE).items[0];
const signal = listSignals(db, {}, PAGE).items[0];
const fileDetail = getFile(db, file.file_id, 200);

/** Click every control the screen shows, twice, so a dialog opens and answers. */
async function clickEveryControl(root: HTMLElement): Promise<void> {
  const user = userEvent.setup({ delay: null });
  for (let pass = 0; pass < 2; pass += 1) {
    const controls = [
      ...root.querySelectorAll<HTMLElement>("button"),
      ...document.querySelectorAll<HTMLElement>("[role='dialog'] button"),
    ];
    for (const control of controls) {
      if (!control.isConnected || control.hasAttribute("disabled")) continue;
      await user.click(control);
    }
  }
}

const screens: ReadonlyArray<{ name: string; element: () => React.ReactElement }> = [
  { name: "the sidebar", element: () => <Sidebar /> },
  { name: "the file detail screen", element: () => <FileDetailScreen fileId={file.file_id} /> },
  { name: "the run detail screen", element: () => <RunDetailScreen runId={run.run_id} /> },
  { name: "the signal detail screen", element: () => <SignalDetailScreen name={signal.name} /> },
  {
    name: "the file signals table",
    element: () => (
      <FileSignalsTable signals={fileDetail.signals} signalCount={fileDetail.signal_count} />
    ),
  },
  {
    name: "the run signals tab",
    element: () => <SignalsTab runId={run.run_id} signalCount={run.signal_count} selected={[]} onSelectedChange={() => {}} />,
  },
];

/* The QuixLab controls show only when a URL reaches `lib/quixlab.ts`. The
   server reads `TM_QUIXLAB_URL` and a provider calls the setter, so a test
   calls the setter itself. */
const quixLabStates = [
  { label: "no QuixLab URL configured", url: "" },
  { label: "a QuixLab URL configured", url: "https://quixlab.dev.quix.io" },
] as const;

describe("no screen answers a click with a placeholder toast", () => {
  beforeEach(() => {
    toasts.length = 0;
  });

  afterEach(() => {
    setQuixLabUrl(null);
    vi.unstubAllEnvs();
  });

  for (const quixLab of quixLabStates) {
    for (const target of screens) {
      it(`${target.name}, with ${quixLab.label}`, async () => {
        setQuixLabUrl(quixLab.url);
        const { container } = renderScreen(target.element());
        await clickEveryControl(container);

        const placeholders = toasts.filter((message) => message.startsWith("Would"));
        expect(placeholders).toEqual([]);
      }, 30_000);
    }
  }
});

/* The two passes above only guard both states if a URL really shows the
   controls. This proves the mechanism on one screen. */
describe("the configured URL is what shows the QuixLab controls", () => {
  afterEach(() => {
    setQuixLabUrl(null);
  });

  it("hides the run detail launch control until a URL reaches the module", () => {
    const hidden = renderScreen(<RunDetailScreen runId={run.run_id} />);
    expect(hidden.queryAllByText("Open in QuixLab")).toHaveLength(0);
    hidden.unmount();

    setQuixLabUrl("https://quixlab.dev.quix.io");
    const shown = renderScreen(<RunDetailScreen runId={run.run_id} />);
    expect(shown.getAllByText("Open in QuixLab").length).toBeGreaterThan(0);
  });
});

/** Every file the front end ships, so a screen this file never renders still fails. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

describe("no source file holds a placeholder toast", () => {
  it("names every toast that starts with Would", () => {
    // Vitest runs with the front-end root as the working directory.
    const frontendRoot = process.cwd();
    const files = ["components", "app", "lib"].flatMap((dir) =>
      sourceFiles(join(frontendRoot, dir))
    );
    // Matches toast("Would …"), toast.error(`Would …`) and the multi-line form.
    const placeholder = /toast(?:\.\w+)?\(\s*[`'"]Would/;

    const offenders = files.filter((path) => placeholder.test(readFileSync(path, "utf8")));

    expect(offenders).toEqual([]);
  });
});
