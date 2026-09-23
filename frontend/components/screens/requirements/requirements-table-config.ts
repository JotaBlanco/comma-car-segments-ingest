import type { TableStateConfig } from "@/lib/table-state";
import type { CsvColumn } from "@/lib/table-csv";
import { EARS_PATTERNS, VERIFICATION_STATES, type RequirementRow } from "@/types";

/**
 * URL-backed filter state for the requirements list (requirements-page spec
 * §11, widened per the dispatch brief's "filter by any column" decision).
 * `chapter` / `status` / `state` / `method` are the read contract's own
 * filters (§10.1/§11.2); every other multi/single key extends beyond it —
 * see the architecture doc's "Beyond §10" section.
 */
export const REQUIREMENTS_TABLE_CONFIG: TableStateConfig = {
  multiKeys: [
    "chapter",
    "status",
    "state",
    "method",
    "ears_pattern",
    "system_state",
    "measurand",
    "source",
  ],
  singleKeys: ["revision", "related_req", "has_verified_by", "has_latest_run"],
  sortKeys: [], // GET /requirements whitelists none — the server orders by req_id ascending.
  defaultSort: null,
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100, 200, 500],
  quickViews: [
    { id: "all", params: {} },
    { id: "no-evidence", params: { state: ["not_covered", "covered"] } },
    { id: "failed", params: { state: ["failed"] } },
    { id: "tested", params: { state: ["tested"] } },
  ],
};

export const VERIFICATION_STATE_LABEL: Record<(typeof VERIFICATION_STATES)[number], string> = {
  not_covered: "Not covered",
  covered: "Covered",
  exercised: "Exercised",
  failed: "Failed",
  tested: "Tested",
};

export { EARS_PATTERNS };

/** "Any / Has one / Has none" — presence/absence for a derived column, per
    the dispatch brief's rule for the widened filterable set. */
export const PRESENCE_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "true", label: "Has one" },
  { value: "false", label: "Has none" },
] as const;

/* A CSV joins a chip cell's members with "; " — the same separator the mock
   uses nowhere else on this page, but plain enough that no requirement's own
   text is likely to collide with it. */
const join = (values: readonly string[]): string => values.join("; ");

/**
 * The export's column set — the full widened attribute list, so the CSV
 * remains the reach-everything-else surface this repo already uses (§6 of
 * the requirements-page spec).
 *
 * It is independent of the table's own column list
 * (`requirements-columns.tsx`) and of what the Columns menu hides: hiding is
 * a view, and a file a person exports carries every column either way.
 */
export const REQUIREMENT_CSV_COLUMNS: readonly CsvColumn<RequirementRow>[] = [
  { header: "Requirement", value: (row) => row.req_id },
  { header: "Title", value: (row) => row.title },
  { header: "Chapter", value: (row) => row.chapter },
  { header: "Status", value: (row) => row.status },
  { header: "Verification", value: (row) => row.verification_state },
  { header: "Evidence stale", value: (row) => (row.evidence_stale ? "yes" : "no") },
  { header: "Method", value: (row) => row.verification_method },
  { header: "EARS pattern", value: (row) => row.ears_pattern },
  { header: "System states", value: (row) => join(row.system_states ?? []) },
  {
    header: "Measurands",
    value: (row) => join((row.measurand ?? []).map((m) => `${m.name} (${m.unit})`)),
  },
  { header: "Revision", value: (row) => row.revision },
  { header: "Source", value: (row) => join(row.source ?? []) },
  { header: "Related requirements", value: (row) => join(row.related_reqs ?? []) },
  { header: "Verified by", value: (row) => join(row.verified_by) },
  { header: "Latest run", value: (row) => row.latest_run_id },
  { header: "Covering runs", value: (row) => row.covering_run_count, type: "number" },
  { header: "Tested at", value: (row) => row.tested_at, type: "date" },
  { header: "Synced at", value: (row) => row.synced_at, type: "date" },
];
