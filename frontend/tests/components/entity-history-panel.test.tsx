/**
 * The history panel of the file, signal, work-order and definition screens
 * (contract §8b).
 *
 * The test drives the real path: the hook, the API client and `fetch`. It
 * proves three things. Each screen asks its own route. The panel renders the
 * shared `JournalTimeline`, so an entry reads the same way everywhere. The two
 * waiting states show while the answer is missing.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { EntityHistoryPanel } from "@/components/shared/entity-history-panel";
import {
  useFileJournal,
  useSignalJournal,
  useTestDefinitionJournal,
  useWorkOrderJournal,
} from "@/lib/hooks";
import type { JournalEntry, Paginated } from "@/types";

const FILE_ID = "f-9a41c2d0";
const SIGNAL_NAME = "HV_Batt_Cell_Temp_Max";
const WO_ID = "WO-2026-0847";
const TD_ID = "TD-BAT-114";

let calls: string[] = [];
let answer: () => Response = () => json(page([entry()]));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "j-1",
    entity_type: "file",
    entity_id: FILE_ID,
    field: "file.downloaded",
    kind: "event",
    old: null,
    new: null,
    source: "manual",
    actor: "a.bergstrom",
    actor_id: null,
    note: "Downloaded bat_cyc.mf4 (2048 bytes)",
    at: "2026-08-14T11:32:04Z",
    ...overrides,
  };
}

function page(items: JournalEntry[]): Paginated<JournalEntry> {
  return { items, total: items.length, page: 1, page_size: 50, total_pages: 1 };
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** One harness per entity type. Each one drives its real hook. */
function FileHistory() {
  const query = useFileJournal(FILE_ID, { page_size: 50 });
  return (
    <EntityHistoryPanel
      label="file"
      isPending={query.isPending}
      isError={query.isError}
      page={query.data}
      onRetry={() => void query.refetch()}
    />
  );
}

function SignalHistory() {
  const query = useSignalJournal(SIGNAL_NAME, { page_size: 50 });
  return (
    <EntityHistoryPanel
      label="signal"
      isPending={query.isPending}
      isError={query.isError}
      page={query.data}
      onRetry={() => void query.refetch()}
    />
  );
}

function WorkOrderHistory() {
  const query = useWorkOrderJournal(WO_ID, { page_size: 50 });
  return (
    <EntityHistoryPanel
      label="work order"
      isPending={query.isPending}
      isError={query.isError}
      page={query.data}
      onRetry={() => void query.refetch()}
    />
  );
}

function DefinitionHistory() {
  const query = useTestDefinitionJournal(TD_ID, { page_size: 50 });
  return (
    <EntityHistoryPanel
      label="definition"
      isPending={query.isPending}
      isError={query.isError}
      page={query.data}
      onRetry={() => void query.refetch()}
    />
  );
}

beforeEach(() => {
  calls = [];
  answer = () => json(page([entry()]));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      calls.push(input);
      return Promise.resolve(answer());
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CASES = [
  ["file", FileHistory, `/api/proxy/files/${FILE_ID}/journal?page_size=50`],
  ["signal", SignalHistory, `/api/proxy/signals/${SIGNAL_NAME}/journal?page_size=50`],
  ["work order", WorkOrderHistory, `/api/proxy/work-orders/${WO_ID}/journal?page_size=50`],
  ["definition", DefinitionHistory, `/api/proxy/test-definitions/${TD_ID}/journal?page_size=50`],
] as const;

describe("the entity history panel", () => {
  for (const [label, Harness, url] of CASES) {
    it(`asks the ${label} journal route`, async () => {
      render(<Harness />, { wrapper: Wrapper });
      await waitFor(() => expect(calls).toEqual([url]));
    });

    it(`renders the ${label} entries in the shared timeline`, async () => {
      render(<Harness />, { wrapper: Wrapper });
      expect(await screen.findByText("file.downloaded")).toBeInTheDocument();
      // The source badge of the shared timeline, and the actor line.
      expect(screen.getByText(/a\.bergstrom/)).toBeInTheDocument();
      expect(screen.getByText("1 entry")).toBeInTheDocument();
    });

    it(`shows the ${label} error state when the read fails`, async () => {
      answer = () => json({ detail: "boom", code: "internal_error", errors: [] }, 500);
      render(<Harness />, { wrapper: Wrapper });
      expect(
        await screen.findByText(`Could not load the history of this ${label}.`),
      ).toBeInTheDocument();
    });
  }

  it("shows the empty state when the entity has no history yet", async () => {
    answer = () => json(page([]));
    render(<WorkOrderHistory />, { wrapper: Wrapper });
    expect(await screen.findByText("No journal entries")).toBeInTheDocument();
    // The head counts nothing when nothing happened yet.
    expect(screen.queryByText(/^\d+ entr(y|ies)$/)).not.toBeInTheDocument();
  });

  it("counts more than one entry in the plural", async () => {
    answer = () => json(page([entry(), entry({ id: "j-2", field: "file.archived" })]));
    render(<FileHistory />, { wrapper: Wrapper });
    expect(await screen.findByText("2 entries")).toBeInTheDocument();
  });
});
