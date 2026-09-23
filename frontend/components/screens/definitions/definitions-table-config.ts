import type { TableStateConfig } from "@/lib/table-state";
import type { DefinitionStatus } from "@/types";

/**
 * URL-backed filter state for the test definitions list, matched key for key
 * to `GET /test-definitions`: `work_order`, `status` and `requirement` are
 * repeated params, `q` is the free text, `orphaned` is the tri-state the Home
 * panel deep-links.
 *
 * `sortKeys` is empty because the route whitelists none — it always orders by
 * the id ascending. The single `all` quick view is what `clearAll` resets to;
 * this page shows no quick-view segment.
 */
export const DEFINITIONS_TABLE_CONFIG: TableStateConfig = {
  multiKeys: ["work_order", "status", "requirement"],
  singleKeys: ["orphaned"],
  sortKeys: [],
  defaultSort: null,
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100, 200, 500],
  quickViews: [{ id: "all", params: {} }],
};

/** The derived status in words. It is planned versus actual runs, never a
    stored field, so no definition reads one until a run carries it. */
export const DEFINITION_STATUS_LABEL: Record<DefinitionStatus, string> = {
  on_plan: "On plan",
  awaiting_data: "Awaiting data",
};

/** The `orphaned` tri-state: absent lists both. */
export const ORPHANED_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "true", label: "Orphaned" },
  { value: "false", label: "Linked" },
] as const;
