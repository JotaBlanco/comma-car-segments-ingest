import type { Provenance, ProvenanceStatus } from "./result";
import type { SourceSystem } from "./file";
import type { RunStatus } from "./test-run";

export interface LineageWorkOrder {
  wo_id: string;
  title: string;
  project: string;
  source: "api:planning";
}

export interface LineageDefinition {
  td_id: string;
  title: string;
  source: "api:planning";
}

export interface LineageRun {
  run_id: string;
  rig_id: string;
  test_cell: string | null;
  first_data_at: string;
  file_count: number;
  signal_count: number;
  status: RunStatus;
}

export interface LineageFile {
  file_id: string;
  filename: string;
  source_system: SourceSystem;
  size_bytes: number;
  signal_count: number;
}

export interface LineageResult {
  result_id: string;
  name: string;
  version: number;
  provenance_status: ProvenanceStatus;
  provenance: Provenance;
}

export interface LineageResponse {
  work_order: LineageWorkOrder | null;
  definition: LineageDefinition | null;
  run: LineageRun;
  files: LineageFile[];
  results: LineageResult[];
}
