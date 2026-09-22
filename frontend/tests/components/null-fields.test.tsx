import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type {
  FileDetail,
  LineageResponse,
  RecentRun,
  SignalDetail,
  SignalRunStatsResponse,
  TestRun,
  TestRunListItem,
} from "@/types";

// The contract allows a null timestamp, a null test_cell, a null
// ingestion_job_id and a null description. The screens must print an em dash
// for each one. Before this test a null timestamp printed 01:00:00, and a null
// test_cell printed the four letters "null".
const DASH = "—";

const { data } = vi.hoisted(() => ({
  data: {
    file: null as unknown,
    run: null as unknown,
    lineage: null as unknown,
    signal: null as unknown,
    signalStats: null as unknown,
    runs: null as unknown,
  },
}));

const settled = (value: unknown) => ({
  data: value,
  isPending: false,
  isError: false,
  isSuccess: true,
  error: null,
  refetch: vi.fn(),
});

const emptyPage = settled({ items: [], total: 0, page: 1, page_size: 100, total_pages: 1 });

vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  // Every write control reads the actor from the signed-in Portal identity.
  useActor: () => "Test Engineer",
  useClearInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useAddRunNote: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchRun: () => ({ mutate: vi.fn(), isPending: false }),
  useFile: () => settled(data.file),
  useFileJournal: () => emptyPage,
  useSignalJournal: () => emptyPage,
  // The file detail screen shows the version history and the lifecycle
  // controls, so the mock answers their hooks too.
  useFileVersions: () => settled({ items: [], total: 0 }),
  useFileLifecycle: () => ({ mutate: vi.fn(), isPending: false }),
  useRegisterFileVersion: () => ({ mutate: vi.fn(), isPending: false }),
  useRun: () => settled(data.run),
  useRunLineage: () => settled(data.lineage),
  useRunJournal: () => emptyPage,
  useRunFiles: () => emptyPage,
  useRunSignals: () => emptyPage,
  useSignals: () => emptyPage,
  useSignal: () => settled(data.signal),
  useSignalRunStats: () => settled(data.signalStats),
  useRuns: () => (data.runs === null ? emptyPage : settled(data.runs)),
  useResults: () => emptyPage,
  // The run edit dialog picks a work order from the mirrored list.
  useWorkOrders: () => emptyPage,
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  // The unit autocomplete reads the whole catalog's units (§14b).
  useSignalFacets: () => ({ data: { units: [], rates: [], rigs: [] }, isPending: false, isError: false, isSuccess: true }),
  useFlagInvalid: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { FileDetailScreen } from "@/components/screens/files/file-detail-screen";
import { LineageScreen } from "@/components/screens/lineage/lineage-screen";
import { RunDetailScreen } from "@/components/screens/run-detail/run-detail-screen";
import { RecentRunsPanel } from "@/components/screens/home/recent-runs-panel";
import { SignalDetailScreen } from "@/components/screens/signals/signal-detail-screen";

const file: FileDetail = {
  file_id: "f-null-1",
  filename: "bat_cyc_20260814_0941.mf4",
  run_id: null,
  source_system: "TAS",
  format: "MF4",
  size_bytes: 4096,
  checksum_sha256: "a".repeat(64),
  checksum_state: "verified",
  status: "quarantined",
  quarantine_reason: null,
  signal_count: 0,
  time_start: null,
  time_end: null,
  registered_at: "2026-08-14T09:41:00Z",
  storage_ref: null,
  ingestion_job_id: null,
  field_sources: {},
  ingestion_timeline: [],
  signals: [],
};

const run: TestRun = {
  run_id: "TAS-90001",
  description: "battery cycle",
  definition_id: null,
  work_order_id: null,
  project: null,
  rig_id: "RIG-04",
  test_cell: null,
  file_count: 0,
  signal_count: 0,
  first_data_at: "2026-08-14T09:41:00Z",
  status: "awaiting_work_order",
  invalid: { flagged: false, reason: null, actor: null, at: null },
  operator: null,
  bench_sw: null,
  started_at: null,
  ended_at: null,
  result_count: 0,
  journal_count: 0,
  field_sources: {},
  created_at: "2026-08-14T09:41:00Z",
  updated_at: "2026-08-14T09:41:00Z",
  custom_properties: {},
};

const lineage: LineageResponse = {
  work_order: null,
  definition: null,
  run: {
    run_id: "TAS-90001",
    rig_id: "RIG-04",
    test_cell: null,
    first_data_at: "2026-08-14T09:41:00Z",
    file_count: 0,
    signal_count: 0,
    status: "awaiting_work_order",
  },
  files: [],
  results: [],
};

/** The text of the value box that sits under a metadata label. */
function metaValue(label: string): string {
  const box = screen.getByText(label).nextElementSibling;
  expect(box).not.toBeNull();
  return (box as HTMLElement).textContent ?? "";
}

/** The four letters "null" as a word, never a class name or an id. */
const NULL_WORD = /\bnull\b/;

/* The run screen's QuixLab panel invalidates the results queries on Save and Close,
   so a render of the screen needs a client to invalidate against. */
function withClient(node: React.ReactElement): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe("a field the API sent as null", () => {
  it("prints an em dash on the file screen, and never a clock", () => {
    data.file = file;
    data.run = undefined;
    render(<FileDetailScreen fileId={file.file_id} />);

    expect(metaValue("Time range")).toBe(`${DASH} → ${DASH}`);
    expect(metaValue("Ingestion job")).toBe(DASH);
    expect(metaValue("Storage location")).toContain(DASH);

    const page = document.body.textContent ?? "";
    expect(page).not.toContain("01:00:00");
    expect(page).not.toMatch(NULL_WORD);
  });

  it("prints an em dash on the run screen, and never a clock", () => {
    data.run = run;
    render(withClient(<RunDetailScreen runId={run.run_id} />));

    expect(metaValue("Test cell")).toBe(DASH);
    expect(metaValue("Time range")).toBe(`${DASH} → ${DASH}`);

    const page = document.body.textContent ?? "";
    expect(page).not.toContain("01:00:00");
    expect(page).not.toMatch(NULL_WORD);
  });

  it("prints an em dash on the lineage screen, and never the word null", () => {
    data.lineage = lineage;
    render(<LineageScreen runId="TAS-90001" />);

    expect(screen.getByText(`RIG-04 / ${DASH}`)).toBeInTheDocument();

    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(NULL_WORD);
  });
});

const recentRun: RecentRun = {
  run_id: "TAS-90002",
  description: null,
  definition_id: null,
  work_order_id: null,
  rig_id: "RIG-04",
  first_data_at: "2026-08-14T10:12:00Z",
  status: "awaiting_work_order",
};

const signal: SignalDetail = {
  name: "batt_temp_01",
  description: null,
  unit: "degC",
  unit_source: null,
  dtype: "float32",
  typical_rate_hz: 10,
  run_count: 1,
  first_seen: "2026-08-01T08:00:00Z",
  last_seen: "2026-08-14T09:41:00Z",
  sensor_ref: null,
  catalogue_ref: null,
  rig_ids: ["RIG-04"],
  field_sources: {},
};

const signalRun: TestRunListItem = {
  run_id: "TAS-90003",
  description: null,
  definition_id: null,
  work_order_id: null,
  project: null,
  rig_id: "RIG-04",
  test_cell: null,
  file_count: 1,
  signal_count: 1,
  first_data_at: "2026-08-14T09:41:00Z",
  status: "awaiting_work_order",
  invalid: { flagged: false, reason: null, actor: null, at: null },
};

const signalStats: SignalRunStatsResponse = {
  name: signal.name,
  unit: signal.unit,
  window: "run",
  items: [
    {
      run_id: signalRun.run_id,
      definition_id: null,
      rig_id: "RIG-04",
      run_date: "2026-08-14",
      status: "awaiting_work_order",
      min: 1,
      max: 2,
      mean: 1.5,
      std: 0.5,
    },
  ],
  total: 1,
  page: 1,
  page_size: 50,
  total_pages: 1,
};

describe("a description the API sent as null", () => {
  it("prints an em dash on the run screen", () => {
    data.run = { ...run, description: null };
    render(withClient(<RunDetailScreen runId={run.run_id} />));

    const page = document.body.textContent ?? "";
    expect(page).toContain(`${DASH} · registered automatically when data arrived`);
    expect(page).not.toMatch(NULL_WORD);
  });

  it("prints an em dash on the home recent-runs panel", () => {
    render(
      <RecentRunsPanel runs={[recentRun]} isPending={false} isError={false} onRetry={vi.fn()} />
    );

    /* The run id sits inside the first-cell link (RowLinkLabel), so the
       description div is the LINK's next sibling, not the span's. */
    const idLink = screen.getByText(recentRun.run_id).closest("a");
    expect(idLink).not.toBeNull();
    const cell = (idLink as HTMLElement).nextElementSibling;
    expect(cell).not.toBeNull();
    expect((cell as HTMLElement).textContent).toBe(DASH);
    expect(document.body.textContent ?? "").not.toMatch(NULL_WORD);
  });

  it("prints an em dash for the signal and for its run row", () => {
    data.signal = signal;
    data.signalStats = signalStats;
    data.runs = { items: [signalRun], total: 1, page: 1, page_size: 100, total_pages: 1 };
    render(<SignalDetailScreen name={signal.name} />);

    const page = document.body.textContent ?? "";
    expect(page).toContain(`${DASH} · cataloged automatically at first ingestion`);

    /* Same shape as the recent-runs panel: the id lives inside the first-cell
       link, and the description renders beside the link. */
    const runIdLink = screen.getByText(signalRun.run_id).closest("a");
    expect(runIdLink).not.toBeNull();
    const runCell = (runIdLink as HTMLElement).nextElementSibling;
    expect(runCell).not.toBeNull();
    expect((runCell as HTMLElement).textContent).toBe(DASH);
    expect(page).not.toMatch(NULL_WORD);
  });
});
