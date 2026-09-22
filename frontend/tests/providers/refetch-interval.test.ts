/**
 * The demo's live surfaces refresh themselves every 10 s, so a dropped file
 * appears while the presenter stands still: the runs list, Home, the run
 * detail trio (run/files/signals — the amber→green flip must land without a
 * click), and the files list where the screen opts in. The planning-sync
 * status polls too, slower, for a different reason — see its case below.
 * Nothing else polls.
 *
 * The second half of this file matters as much as the first: it pins the
 * absence of a poll on every other query, and on the client default.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { seen } = vi.hoisted(() => ({ seen: [] as Record<string, unknown>[] }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    seen.push(options);
    return {};
  },
  useMutation: () => ({}),
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
}));

import {
  useFile,
  useFiles,
  useHomeSummary,
  usePlanningSyncStatus,
  useResults,
  useRun,
  useRunFiles,
  useRunJournal,
  useRunLineage,
  useRunSignals,
  useRuns,
  useSearch,
  useSignal,
  useSignalRunStats,
  useSignals,
  useWorkOrder,
  useWorkOrders,
} from "@/lib/hooks";

const LIVE_INTERVAL_MS = 10_000;
const SYNC_STATUS_INTERVAL_MS = 15_000;
const ROOT = path.resolve(__dirname, "..", "..");

function optionsOf(call: () => unknown): Record<string, unknown> {
  seen.length = 0;
  call();
  expect(seen).toHaveLength(1);
  return seen[0];
}

beforeEach(() => {
  seen.length = 0;
});

describe("the live queries poll", () => {
  it("polls the runs list every 10 s", () => {
    expect(optionsOf(() => useRuns()).refetchInterval).toBe(LIVE_INTERVAL_MS);
  });

  it("polls the runs list with filters every 10 s", () => {
    expect(optionsOf(() => useRuns({ status: ["complete"] })).refetchInterval).toBe(
      LIVE_INTERVAL_MS,
    );
  });

  it("polls Home every 10 s", () => {
    expect(optionsOf(() => useHomeSummary()).refetchInterval).toBe(LIVE_INTERVAL_MS);
  });

  /* Run detail polls so Act 2's amber→green lands even when the planning
     mock pushes on its own timer — no click, no invalidate, still fresh. */
  it("polls the run detail trio every 10 s", () => {
    expect(optionsOf(() => useRun("run-1")).refetchInterval).toBe(LIVE_INTERVAL_MS);
    expect(optionsOf(() => useRunFiles("run-1")).refetchInterval).toBe(LIVE_INTERVAL_MS);
    expect(optionsOf(() => useRunSignals("run-1")).refetchInterval).toBe(LIVE_INTERVAL_MS);
  });

  /* The files LIST polls only where the runbook needs it ("Navigate to
     Files while they land") — the caller opts in; the default stays still. */
  it("polls the files list only when the caller opts in", () => {
    // The hook states `false` explicitly rather than omitting the key —
    // either way, no poll.
    expect(optionsOf(() => useFiles()).refetchInterval).toBe(false);
    expect(optionsOf(() => useFiles({}, { poll: true })).refetchInterval).toBe(LIVE_INTERVAL_MS);
  });

  /* The planning-sync status is not a live surface, so it polls slower and
     for another reason: the topbar's demo controls disable while the status
     is unknown. Without a poll, one failed load — an API cold start, a blip —
     left them disabled for ever, because react-query stops after its retries
     and nothing asks again. The poll also keeps the switch honest when a
     second tab toggles it. */
  it("polls the planning-sync status every 15 s", () => {
    expect(optionsOf(() => usePlanningSyncStatus()).refetchInterval).toBe(
      SYNC_STATUS_INTERVAL_MS,
    );
  });

  it("lets a caller switch the runs poll off (the search palette does)", () => {
    expect(optionsOf(() => useRuns({}, { poll: false })).refetchInterval).toBe(false);
  });
});

describe("no other query polls", () => {
  const others: [string, () => unknown][] = [
    ["useRunJournal", () => useRunJournal("run-1")],
    ["useRunLineage", () => useRunLineage("run-1")],
    ["useWorkOrders", () => useWorkOrders()],
    ["useWorkOrder", () => useWorkOrder("wo-1")],
    ["useFile", () => useFile("file-1")],
    ["useSignals", () => useSignals()],
    ["useSignal", () => useSignal("speed")],
    ["useSignalRunStats", () => useSignalRunStats("speed")],
    ["useResults", () => useResults()],
    ["useSearch", () => useSearch("abc")],
  ];

  it.each(others)("%s sets no refetchInterval", (_name, call) => {
    expect(optionsOf(call).refetchInterval).toBeUndefined();
  });
});

describe("the source pins the same places", () => {
  it("names refetchInterval in use-runs, use-home, use-files and use-planning-sync only", () => {
    const files = ["use-runs", "use-home", "use-work-orders", "use-files", "use-signals",
      "use-results", "use-search", "use-planning-sync", "keys"];
    const withInterval = files.filter((name) =>
      readFileSync(path.join(ROOT, "lib", "hooks", `${name}.ts`), "utf8").includes("refetchInterval"),
    );
    expect(withInterval.sort()).toEqual([
      "use-files",
      "use-home",
      "use-planning-sync",
      "use-runs",
    ]);
  });

  it("keeps the client default free of a global poll", () => {
    const source = readFileSync(
      path.join(ROOT, "components", "providers", "query-provider.tsx"),
      "utf8",
    );
    expect(source).not.toContain("refetchInterval");
  });
});
