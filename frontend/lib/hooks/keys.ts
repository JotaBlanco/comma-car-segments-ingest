import type {
  FileListFilters,
  JournalKind,
  JournalListFilters,
  PageParams,
  ResultListFilters,
  RunGroupFilters,
  RunListFilters,
  SignalListFilters,
  SignalStatsFilters,
  TestDefinitionListFilters,
  WorkOrderListFilters,
} from "@/types";

/**
 * Deterministic serialization for TanStack query keys.
 * Arrays are sorted (so `{status:["a","b"]}` ≡ `{status:["b","a"]}`);
 * `undefined` values are dropped; object keys are output in a stable order.
 * Only used as the third slot of a list key — the array is never persisted
 * or sent over the wire, so any collation is fine as long as it is stable.
 */
export function normalizeFilters<T extends Record<string, unknown>>(
  filters: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = Object.entries(filters).filter(([, v]) => v !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      // Copy so we do not mutate the caller's array, then stable-sort.
      const sorted = [...value].sort((a, b) => {
        if (typeof a === "number" && typeof b === "number") return a - b;
        return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
      });
      out[key] = sorted;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const keys = {
  home: ["home"] as const,
  /* Read straight from the lake through the FE's own /api/lake handlers. */
  lake: {
    /* One level of the partition tree, keyed by the path it hangs under: a
       level already opened is not read again when the dialog reopens. */
    partitions: (table: string, path: string) =>
      ["lake", "partitions", table, path] as const,
    /* One partition column's values under the pinned ancestors — the
       sessions under the picked tree node. */
    partitionValues: (table: string, column: string, where: Record<string, string>) =>
      ["lake", "partition-values", table, column, normalizeFilters(where)] as const,
    snippets: (table: string, runId: string) =>
      ["lake", "snippets", table, runId] as const,
    snippetData: (table: string, id: number, limit: number) =>
      ["lake", "snippets", table, "data", id, limit] as const,
  },
  planningSync: ["planning-sync"] as const,
  assistantStatus: ["assistant", "status"] as const,
  /* The cross-entity audit read. It hangs off no entity detail key, because
     it belongs to none of them. */
  journal: {
    all: ["journal"] as const,
    list: (filters: JournalListFilters) =>
      ["journal", "list", normalizeFilters(filters)] as const,
    /* The bell's rolling read of the same journal. Its own key, because the
       bell caches an infinite list and the Audit table caches flat pages -
       the two shapes must never share a cache slot. */
    bell: ["journal", "bell"] as const,
  },
  runs: {
    all: ["runs"] as const,
    list: (filters: RunListFilters) =>
      ["runs", "list", normalizeFilters(filters)] as const,
    facets: ["runs", "facets"] as const,
    groups: (filters: RunGroupFilters) =>
      ["runs", "groups", normalizeFilters(filters)] as const,
    detail: (runId: string) => ["runs", "detail", runId] as const,
    files: (runId: string, params: unknown = {}) =>
      ["runs", "detail", runId, "files", params] as const,
    signals: (runId: string, params: PageParams) =>
      ["runs", "detail", runId, "signals", params] as const,
    journal: (runId: string, params: PageParams & { kind?: JournalKind }) =>
      ["runs", "detail", runId, "journal", params] as const,
    lineage: (runId: string) => ["runs", "detail", runId, "lineage"] as const,
    exploreContext: (runId: string) =>
      ["runs", "detail", runId, "explore", "context"] as const,
  },
  workOrders: {
    all: ["work-orders"] as const,
    list: (filters: WorkOrderListFilters) =>
      ["work-orders", "list", normalizeFilters(filters)] as const,
    facets: ["work-orders", "facets"] as const,
    detail: (woId: string) => ["work-orders", "detail", woId] as const,
    journal: (woId: string, params: PageParams & { kind?: JournalKind }) =>
      ["work-orders", "detail", woId, "journal", params] as const,
  },
  testDefinitions: {
    all: ["test-definitions"] as const,
    list: (filters: TestDefinitionListFilters) =>
      ["test-definitions", "list", normalizeFilters(filters)] as const,
    detail: (tdId: string) => ["test-definitions", "detail", tdId] as const,
    journal: (tdId: string, params: PageParams & { kind?: JournalKind }) =>
      ["test-definitions", "detail", tdId, "journal", params] as const,
  },
  files: {
    all: ["files"] as const,
    list: (filters: FileListFilters) =>
      ["files", "list", normalizeFilters(filters)] as const,
    detail: (fileId: string) => ["files", "detail", fileId] as const,
    journal: (fileId: string, params: PageParams & { kind?: JournalKind }) =>
      ["files", "detail", fileId, "journal", params] as const,
    versions: (fileId: string) =>
      ["files", "detail", fileId, "versions"] as const,
  },
  signals: {
    all: ["signals"] as const,
    list: (filters: SignalListFilters) =>
      ["signals", "list", normalizeFilters(filters)] as const,
    facets: ["signals", "facets"] as const,
    detail: (name: string) => ["signals", "detail", name] as const,
    journal: (name: string, params: PageParams & { kind?: JournalKind }) =>
      ["signals", "detail", name, "journal", params] as const,
    runStats: (name: string, filters: SignalStatsFilters) =>
      ["signals", "detail", name, "stats", filters] as const,
  },
  results: {
    all: ["results"] as const,
    list: (filters: ResultListFilters) => ["results", "list", filters] as const,
    detail: (resultId: string) => ["results", "detail", resultId] as const,
    /* Nested under the detail key on purpose, like every other entity journal:
       invalidating `detail(resultId)` then refreshes the journal too, so a
       note lands in the timeline with one invalidation. */
    journal: (resultId: string, params: PageParams & { kind?: JournalKind }) =>
      ["results", "detail", resultId, "journal", params] as const,
  },
  search: (q: string, limitPerGroup?: number) =>
    ["search", q, limitPerGroup ?? 5] as const,
  /* The searches the server stores. The device-local list keeps no query
     key, because it is not a query: `lib/saved-searches.ts` is a module
     store over `useSyncExternalStore`. */
  savedSearches: {
    all: ["saved-searches"] as const,
    list: (scope: string, actor: string | null) =>
      ["saved-searches", "list", scope, actor] as const,
  },
};
