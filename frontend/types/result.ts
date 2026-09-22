import type { PageParams } from "./common";

export type ProvenanceStatus = "verified" | "flagged";

export interface Provenance {
  tool: string;
  tool_version: string;
  parameters: string;
  input_file_ids: string[];
  produced_by: string;
  produced_at: string;
}

export interface ProcessedResult {
  result_id: string;
  run_id: string;
  name: string;
  result_key: string;
  version: number;
  supersedes: string | null;
  description: string | null;
  /** Null when the bytes live outside this registry. Then no download exists. */
  storage_ref: string | null;
  provenance: Provenance;
  provenance_status: ProvenanceStatus;
  created_at: string;
  /**
   * The last manual edit of this result, or null while nobody edited it.
   *
   * The API reads it back from the journal, so no second store holds it.
   * `fields` names the changed fields, for example `result.provenance.tool`.
   *
   * The key is optional because an older API build sends no key at all. A
   * screen must treat "absent" and "null" as the same fact: no person edited
   * this result.
   */
  edited?: { at: string; actor: string; fields: string[] } | null;
}

/**
 * The provenance part of `PATCH /results/{result_id}`. Every key is optional,
 * and the route refuses a blank value with 422 `provenance_required`.
 */
export interface ProvenancePatch {
  tool?: string;
  tool_version?: string;
  parameters?: string;
  input_file_ids?: string[];
  produced_by?: string;
  /** ISO-8601 UTC. */
  produced_at?: string;
}

/**
 * Body of `PATCH /results/{result_id}`.
 *
 * The route forbids an unknown key and answers 422, so this body states the
 * patchable fields and no other. `result_id`, `run_id`, `result_key`,
 * `version`, `supersedes`, `storage_ref`, `provenance_status` and `created_at`
 * stay out: they are identity, lineage or a stored verdict.
 */
export interface ResultPatchBody {
  name?: string;
  description?: string;
  provenance?: ProvenancePatch;
  actor: string;
  note?: string;
}

export type ResultListFilters = PageParams & {
  run?: string;
  result_key?: string;
  latest_only?: boolean;
};
