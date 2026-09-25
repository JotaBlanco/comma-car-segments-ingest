import type {
  FieldSources,
  FileLifecycle,
  FileRole,
  FileSignal,
  HomeCounts,
  InvalidFlag,
  JournalEntityType,
  JournalKind,
  ProcessedResult,
  RequirementsFile,
  SourceSystem,
  SourceTag,
  StageStatus,
  SyncResult,
  WorkOrderStatus,
} from "@/types";

export interface RunRecord {
  run_id: string;
  description: string;
  definition_id: string | null;
  work_order_id: string | null;
  project: string | null;
  rig_id: string;
  test_cell: string;
  operator: string | null;
  bench_sw: string | null;
  started_at: string;
  ended_at: string;
  first_data_at: string;
  file_count: number;
  signal_count: number;
  invalid: InvalidFlag;
  field_sources: FieldSources;
  created_at: string;
  updated_at: string;
  /** Free key and value pairs a person types. A seeded run carries none. */
  custom_properties?: Record<string, string>;
}

export interface WorkOrderRecord {
  wo_id: string;
  title: string;
  project: string;
  status: WorkOrderStatus;
  requestor: string;
  department: string;
  priority: string;
  created_at_source: string;
  synced_at: string;
  /** false = exists only in the hidden planning system until a sync pass mirrors it. */
  mirrored: boolean;
  /** The planning tag per field (TR-011). A seeded row carries none yet; the
   *  API tags the mirror on every sync pass and on every seed. */
  field_sources?: FieldSources;
}

export interface DefinitionRecord {
  td_id: string;
  title: string;
  mirrored: boolean;
  /** The requirements documents the definition carries. Empty by default. */
  requirements_files: RequirementsFile[];
  /**
   * The pairs a person typed. Optional here, because a definition seeded
   * before this field existed carries none, and the read answers `{}` for it.
   * A planning sync pass never writes and never erases this map.
   */
  custom_properties?: Record<string, string>;
}

export interface WoDefinitionLink {
  wo_id: string;
  td_id: string;
  planned_runs: number;
}

export interface FileRecord {
  file_id: string;
  filename: string;
  run_id: string | null;
  source_system: SourceSystem;
  /** Absent = a recording, as it is on a document the registry stored before
   *  the field existed. Only a definition run writes "evaluator". */
  role?: FileRole;
  format: string;
  size_bytes: number;
  checksum_sha256: string;
  checksum_state: "verified" | "mismatch" | "unverified";
  status: "registered" | "quarantined";
  quarantine_reason: string | null;
  signal_count: number;
  time_start: string;
  time_end: string;
  registered_at: string;
  storage_ref: string;
  ingestion_job_id: string;
  field_sources: FieldSources;
  /* The six optional fields below back the write routes (M1 — mock parity
     with the 20 Aug 2026 API additions). A seeded row carries none of them,
     matching a registry document from before that date: it reads as active,
     version 1, no stage report — exactly how the real API reads an old
     document. Only the mock write routes set them. */
  lifecycle?: FileLifecycle;
  version?: number;
  /** The chain this version belongs to. Absent = the root of its own chain. */
  version_group?: string;
  /** The file id this version supersedes — the link the chain walks. */
  supersedes?: string | null;
  sync_status?: StageStatus | null;
  upload_status?: StageStatus | null;
  conversion_status?: StageStatus | null;
  stage_error?: string | null;
  /** The invalid mark at file level (24 Aug 2026). Absent = nobody marked it. */
  invalid?: InvalidFlag;
}

export interface SignalRecord {
  name: string;
  description: string;
  unit: string | null;
  unit_source: SourceTag | null;
  dtype: string;
  typical_rate_hz: number;
  run_count: number;
  first_seen: string;
  last_seen: string;
  sensor_ref: string | null;
  catalogue_ref: string | null;
  rig_ids: string[];
  field_sources: FieldSources;
}

export interface StoredRunStat {
  run_id: string;
  min: number;
  max: number;
  mean: number;
  std: number;
}

export interface JournalRecord {
  id: string;
  entity_type: JournalEntityType;
  entity_id: string;
  field: string | null;
  kind: JournalKind;
  old: string | null;
  new: string | null;
  source: SourceTag;
  actor: string;
  /**
   * Portal user id when the Quix platform verified the actor.
   * The mock leaves it unset, so every mock entry reads as an unverified claim.
   */
  actor_id?: string | null;
  note: string | null;
  at: string;
  /** Signal edits made in run context surface in that run's journal (contract §8). */
  context_run_id?: string;
  /** Created by a planning-sync pass — reverted on demo reset. */
  sync_generated?: boolean;
}

export interface MockState {
  planningOnline: boolean;
  lastSyncAt: string | null;
  lastSyncResult: SyncResult | null;
  runs: RunRecord[];
  workOrders: WorkOrderRecord[];
  definitions: DefinitionRecord[];
  woDefinitions: WoDefinitionLink[];
  files: FileRecord[];
  fileSignals: Record<string, FileSignal[]>;
  signals: SignalRecord[];
  signalRunStats: Record<string, StoredRunStat[]>;
  results: ProcessedResult[];
  journal: JournalRecord[];
}

/** Prototype vanity totals — the seeded rows are the drill-down subset. */
export const VANITY_COUNTS: HomeCounts = {
  test_runs: 128,
  files: 512,
  signals: 6412,
  work_orders: 42,
  test_definitions: 7,
  runs_today: 6,
  files_today: 31,
  rig_count: 4,
};

export const WORK_ORDERS_MIRRORED = 42;

export const HERO_RUN_ID = "TAS-88214";
export const SYNC_WO_ID = "WO-2026-0851";
export const SYNC_TD_ID = "TD-BAT-114";
export const SYNC_PROJECT = "EX90";
export const SEED_WO_SYNCED_AT = "2026-08-13T16:20:00Z";
/** A mirrored definition that no work order links — the seeded orphan (TR-001). */
export const ORPHAN_TD_ID = "TD-INV-081";
export const HERO_RUN_SEED_UPDATED_AT = "2026-08-14T09:58:00Z";

export const FILE_IDS = {
  batCyc: "f-9a41c8f2-6d0b-4e17-a35c-72d9e814b061",
  incaCal: "f-41bb63e0-7c25-4d98-b1f4-08a3d5c2e917",
  chamberLog: "f-b7d04c39-2e85-4f1a-9d67-e02a41c5b883",
  emEffQuarantined: "f-6c1f9a2e-07d4-4b85-935e-2a91c6f03d7b",
  emEff0812: "f-c58d3b7a-91e0-4f62-8d1c-25a19b7e3046",
  invDerateQuarantined: "f-2e7d0c4a-91b6-4f85-b5d3-e8a12c04f9b7",
} as const;

const RESULT_ID = "res-77aa19c4-3d6f-4b02-8e51-a9c04d1e7b26";

const noInvalid = (): InvalidFlag => ({ flagged: false, reason: null, actor: null, at: null });

function embeddedSources(at: string): FieldSources {
  return { rig_id: { source: "embedded", actor: "ingestion", at } };
}

function batteryRun(
  runId: string,
  description: string,
  definitionId: string,
  workOrderId: string,
  date: string,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  const registeredAt = `${date}T09:12:33Z`;
  return {
    run_id: runId,
    description,
    definition_id: definitionId,
    work_order_id: workOrderId,
    project: "EX90",
    rig_id: "RIG-04",
    test_cell: "TC-2",
    operator: null,
    bench_sw: "TAS 7.4.2 · fw 2.11",
    started_at: `${date}T09:12:41Z`,
    ended_at: `${date}T10:48:20Z`,
    first_data_at: `${date}T09:12:00Z`,
    file_count: 3,
    signal_count: 142,
    invalid: noInvalid(),
    field_sources: {
      ...embeddedSources(registeredAt),
      bench_sw: { source: "api:config", actor: "config-sync", at: registeredAt },
    },
    created_at: registeredAt,
    updated_at: registeredAt,
    ...overrides,
  };
}

function seedRuns(): RunRecord[] {
  return [
    {
      run_id: HERO_RUN_ID,
      description: "HV battery thermal cycling",
      definition_id: null,
      work_order_id: null,
      project: null,
      rig_id: "RIG-04",
      test_cell: "TC-2",
      operator: "A. Bergström",
      bench_sw: "TAS 7.4.2 · fw 2.11",
      started_at: "2026-08-14T09:41:07Z",
      ended_at: "2026-08-14T11:18:52Z",
      first_data_at: "2026-08-14T09:41:00Z",
      file_count: 3,
      signal_count: 142,
      invalid: noInvalid(),
      field_sources: {
        rig_id: { source: "embedded", actor: "ingestion", at: "2026-08-14T09:41:33Z" },
        operator: { source: "manual", actor: "a.bergstrom", at: "2026-08-14T09:58:00Z" },
        bench_sw: { source: "api:config", actor: "config-sync", at: "2026-08-14T09:42:00Z" },
      },
      created_at: "2026-08-14T09:41:33Z",
      updated_at: HERO_RUN_SEED_UPDATED_AT,
    },
    {
      run_id: "TAS-88213",
      description: "E-machine efficiency map",
      definition_id: "TD-EM-201",
      work_order_id: "WO-2026-0847",
      project: "EX90",
      rig_id: "RIG-02",
      test_cell: "TC-1",
      operator: null,
      bench_sw: "TAS 7.4.2 · fw 2.11",
      started_at: "2026-08-14T08:12:09Z",
      ended_at: "2026-08-14T10:05:41Z",
      first_data_at: "2026-08-14T08:12:00Z",
      file_count: 5,
      signal_count: 96,
      invalid: noInvalid(),
      field_sources: {
        ...embeddedSources("2026-08-14T08:12:30Z"),
        bench_sw: { source: "api:config", actor: "config-sync", at: "2026-08-14T08:12:35Z" },
      },
      created_at: "2026-08-14T08:12:30Z",
      updated_at: "2026-08-14T08:12:30Z",
    },
    {
      run_id: "TAS-88209",
      description: "Inverter derating sweep",
      definition_id: "TD-INV-077",
      work_order_id: "WO-2026-0843",
      project: "EC40",
      rig_id: "RIG-07",
      test_cell: "TC-4",
      operator: null,
      bench_sw: "TAS 7.4.1 · fw 2.10",
      started_at: "2026-08-13T17:26:12Z",
      ended_at: "2026-08-13T18:44:03Z",
      first_data_at: "2026-08-13T17:26:00Z",
      file_count: 2,
      signal_count: 64,
      invalid: {
        flagged: true,
        reason: "Torque ripple sensor fault from cycle 6 — derating sweep data unusable.",
        actor: "e.lindqvist",
        at: "2026-08-13T18:02:00Z",
      },
      field_sources: {
        ...embeddedSources("2026-08-13T17:26:40Z"),
        bench_sw: { source: "api:config", actor: "config-sync", at: "2026-08-13T17:26:45Z" },
      },
      created_at: "2026-08-13T17:26:40Z",
      updated_at: "2026-08-13T18:02:00Z",
    },
    batteryRun("TAS-88207", "HV battery thermal cycling", "TD-BAT-114", "WO-2026-0839", "2026-08-13", {
      started_at: "2026-08-13T14:03:11Z",
      ended_at: "2026-08-13T15:41:58Z",
      first_data_at: "2026-08-13T14:03:00Z",
      created_at: "2026-08-13T14:03:29Z",
      updated_at: "2026-08-13T14:03:29Z",
      field_sources: {
        ...embeddedSources("2026-08-13T14:03:29Z"),
        bench_sw: { source: "api:config", actor: "config-sync", at: "2026-08-13T14:03:35Z" },
      },
      file_count: 4,
    }),
    {
      run_id: "TAS-88201",
      description: "E-machine efficiency map",
      definition_id: "TD-EM-201",
      work_order_id: "WO-2026-0847",
      project: "EX90",
      rig_id: "RIG-02",
      test_cell: "TC-1",
      operator: null,
      bench_sw: "TAS 7.4.2 · fw 2.11",
      started_at: "2026-08-13T11:47:04Z",
      ended_at: "2026-08-13T13:39:50Z",
      first_data_at: "2026-08-13T11:47:00Z",
      file_count: 5,
      signal_count: 96,
      invalid: noInvalid(),
      field_sources: {
        ...embeddedSources("2026-08-13T11:47:22Z"),
        bench_sw: { source: "api:config", actor: "config-sync", at: "2026-08-13T11:47:28Z" },
      },
      created_at: "2026-08-13T11:47:22Z",
      updated_at: "2026-08-13T11:47:22Z",
    },
    batteryRun("TAS-88198", "HV battery thermal cycling", "TD-BAT-114", "WO-2026-0812", "2026-08-08"),
    batteryRun("TAS-88190", "HV battery thermal cycling — summer cycle", "TD-BAT-102", "WO-2026-0839", "2026-08-01"),
    batteryRun("TAS-88183", "HV battery thermal cycling — summer cycle", "TD-BAT-102", "WO-2026-0839", "2026-07-24"),
    batteryRun("TAS-88177", "HV battery thermal cycling — summer cycle", "TD-BAT-102", "WO-2026-0812", "2026-07-17"),
    batteryRun("TAS-88168", "HV battery thermal cycling — summer cycle", "TD-BAT-102", "WO-2026-0812", "2026-07-09"),
    batteryRun("TAS-88159", "HV battery thermal cycling — winter cycle", "TD-BAT-114", "WO-2026-0812", "2026-07-01"),
    batteryRun("TAS-88150", "HV battery thermal cycling — winter cycle", "TD-BAT-114", "WO-2026-0812", "2026-06-24"),
    batteryRun("TAS-88141", "HV battery thermal cycling — summer cycle", "TD-BAT-102", "WO-2026-0812", "2026-06-17"),
    batteryRun("TAS-88123", "HV battery thermal cycling — winter cycle", "TD-BAT-114", "WO-2026-0812", "2026-06-09"),
    batteryRun("TAS-88104", "HV battery thermal cycling — winter cycle", "TD-BAT-114", "WO-2026-0812", "2026-06-02"),
  ];
}

function seedWorkOrders(): WorkOrderRecord[] {
  return [
    {
      wo_id: "WO-2026-0847",
      title: "E-machine efficiency characterisation",
      project: "EX90",
      status: "active",
      requestor: "M. Ekholm · Propulsion",
      department: "Propulsion Test Labs",
      priority: "P2 — standard",
      created_at_source: "2026-08-03T00:00:00Z",
      synced_at: SEED_WO_SYNCED_AT,
      mirrored: true,
    },
    {
      wo_id: "WO-2026-0843",
      title: "Inverter thermal derating — phase 2",
      project: "EC40",
      status: "closed",
      requestor: "S. Vidal · Powertrain",
      department: "Propulsion Test Labs",
      priority: "P2 — standard",
      created_at_source: "2026-07-28T00:00:00Z",
      synced_at: SEED_WO_SYNCED_AT,
      mirrored: true,
    },
    {
      wo_id: "WO-2026-0839",
      title: "HV battery thermal validation — summer cycle",
      project: "EX90",
      status: "closed",
      requestor: "L. Åkesson · Battery",
      department: "Propulsion Test Labs",
      priority: "P2 — standard",
      created_at_source: "2026-07-20T00:00:00Z",
      synced_at: SEED_WO_SYNCED_AT,
      mirrored: true,
    },
    {
      wo_id: "WO-2026-0812",
      title: "HV battery thermal validation — phase 1",
      project: "EX90",
      status: "closed",
      requestor: "L. Åkesson · Battery",
      department: "Propulsion Test Labs",
      priority: "P2 — standard",
      created_at_source: "2026-05-28T00:00:00Z",
      synced_at: SEED_WO_SYNCED_AT,
      mirrored: true,
    },
    {
      wo_id: SYNC_WO_ID,
      title: "HV battery thermal validation — winter cycle",
      project: "EX90",
      status: "active",
      requestor: "L. Åkesson · Battery",
      department: "Propulsion Test Labs",
      priority: "P1 — expedite",
      created_at_source: "2026-08-12T00:00:00Z",
      synced_at: SEED_WO_SYNCED_AT,
      mirrored: false,
    },
  ];
}

/** The one manual actor the seed uses, so a demo name never varies. */
const SEED_ACTOR = "a.bergstrom";

/** The planning document the hero definition carries. */
const SEED_PLANNING_REQUIREMENTS = `# Thermal cycling −20 °C → +40 °C

The definition covers the **cold-to-warm** cycle of the HV battery pack.

## Acceptance

1. The pack reaches +40 °C within 45 min.
2. No cell passes 47 °C.
3. The coolant flow stays above 4 l/min.

## Instrumented signals

- HV_Batt_Cell_Temp_Max
- Coolant_Inlet_Temp
- Coolant_Flow_Rate

| Signal | Unit |
|---|---|
| HV_Batt_Cell_Temp_Max | °C |
| Coolant_Flow_Rate | l/min |
`;

function seedDefinitions(): DefinitionRecord[] {
  return [
    {
      td_id: "TD-BAT-102",
      title: "HV battery thermal cycling · +10 °C → +45 °C",
      mirrored: true,
      requirements_files: [],
    },
    {
      td_id: "TD-BAT-114",
      title: "HV battery thermal cycling · −20 °C → +40 °C",
      mirrored: true,
      requirements_files: [
        {
          name: "acceptance-criteria.md",
          content: SEED_PLANNING_REQUIREMENTS,
          source: "planning",
          updated_at: "2026-08-13T07:44:00Z",
          updated_by: null,
        },
        {
          name: "rig-notes.md",
          content:
            "## Rig notes\n\nThe chamber door seal needs a check before every cold soak.\n\n- Check the seal.\n- Log the chamber pressure.\n",
          source: "manual",
          updated_at: "2026-08-14T10:12:00Z",
          updated_by: SEED_ACTOR,
        },
      ],
      custom_properties: { "chamber id": "CH-02", "fixture": "FX-114-B" },
    },
    {
      td_id: "TD-BAT-118",
      title: "HV battery thermal cycling · cold-soak extension",
      mirrored: false,
      requirements_files: [],
    },
    {
      td_id: "TD-EM-201",
      title: "E-machine efficiency map — WLTP points",
      mirrored: true,
      requirements_files: [],
    },
    {
      td_id: "TD-EM-204",
      title: "E-machine efficiency map — high-load extension",
      mirrored: true,
      requirements_files: [],
    },
    {
      td_id: "TD-INV-077",
      title: "Inverter derating sweep · thermal limits",
      mirrored: true,
      requirements_files: [],
    },
    // No work order links this one. It is the seeded orphan.
    {
      td_id: ORPHAN_TD_ID,
      title: "Inverter derating sweep · cold-plate variant",
      mirrored: true,
      requirements_files: [],
    },
  ];
}

function seedWoDefinitions(): WoDefinitionLink[] {
  return [
    { wo_id: "WO-2026-0847", td_id: "TD-EM-201", planned_runs: 2 },
    { wo_id: "WO-2026-0847", td_id: "TD-EM-204", planned_runs: 1 },
    { wo_id: "WO-2026-0843", td_id: "TD-INV-077", planned_runs: 1 },
    { wo_id: "WO-2026-0839", td_id: "TD-BAT-114", planned_runs: 1 },
    { wo_id: "WO-2026-0839", td_id: "TD-BAT-102", planned_runs: 2 },
    { wo_id: "WO-2026-0812", td_id: "TD-BAT-114", planned_runs: 5 },
    { wo_id: "WO-2026-0812", td_id: "TD-BAT-102", planned_runs: 3 },
    { wo_id: SYNC_WO_ID, td_id: "TD-BAT-114", planned_runs: 4 },
    { wo_id: SYNC_WO_ID, td_id: "TD-BAT-118", planned_runs: 2 },
  ];
}

function seedFiles(): FileRecord[] {
  const embeddedAt = "2026-08-14T09:41:33Z";
  const fileSources = (at: string): FieldSources => ({
    size_bytes: { source: "embedded", actor: "ingestion", at },
    checksum_sha256: { source: "embedded", actor: "ingestion", at },
  });
  return [
    {
      file_id: FILE_IDS.batCyc,
      filename: "bat_cyc_20260814_0941.mf4",
      run_id: HERO_RUN_ID,
      source_system: "TAS",
      format: "MDF 4.10",
      size_bytes: 1331439861,
      checksum_sha256: "9f2c8a41d6e0b3f73d5a1e8c04d9b6273fa08e51c47d92e6b30f14c2ad90e1a7",
      checksum_state: "verified",
      status: "registered",
      quarantine_reason: null,
      signal_count: 96,
      time_start: "2026-08-14T09:41:07Z",
      time_end: "2026-08-14T11:18:52Z",
      registered_at: embeddedAt,
      storage_ref: "blob://test-manager/landing/rig-04/2026/08/14/bat_cyc_20260814_0941.mf4",
      ingestion_job_id: "ing-20260814-0941-77c2",
      field_sources: fileSources(embeddedAt),
    },
    {
      file_id: FILE_IDS.incaCal,
      filename: "inca_cal_20260814_0941.mf4",
      run_id: HERO_RUN_ID,
      source_system: "INCA",
      format: "MDF 4.10",
      size_bytes: 327155712,
      checksum_sha256: "41bb7e02c9d5a8134f60eb27d491c8a5023f7b6e19d0c4825a7e3f1b6d4809c3",
      checksum_state: "verified",
      status: "registered",
      quarantine_reason: null,
      signal_count: 41,
      time_start: "2026-08-14T09:41:10Z",
      time_end: "2026-08-14T11:18:40Z",
      registered_at: "2026-08-14T09:42:05Z",
      storage_ref: "blob://test-manager/landing/rig-04/2026/08/14/inca_cal_20260814_0941.mf4",
      ingestion_job_id: "ing-20260814-0941-77c3",
      field_sources: fileSources("2026-08-14T09:42:05Z"),
    },
    {
      file_id: FILE_IDS.chamberLog,
      filename: "chamber_log_0941.csv",
      run_id: HERO_RUN_ID,
      source_system: "ifile",
      format: "CSV",
      size_bytes: 2516582,
      checksum_sha256: "b7d04e91a2c85f37d6b0e814c92a7f53e1d68b04a9c2735fe80d1b6c93a44421",
      checksum_state: "verified",
      status: "registered",
      quarantine_reason: null,
      signal_count: 5,
      time_start: "2026-08-14T09:41:00Z",
      time_end: "2026-08-14T11:19:00Z",
      registered_at: "2026-08-14T09:42:18Z",
      storage_ref: "blob://test-manager/landing/rig-04/2026/08/14/chamber_log_0941.csv",
      ingestion_job_id: "ing-20260814-0941-77c4",
      field_sources: fileSources("2026-08-14T09:42:18Z"),
    },
    {
      file_id: FILE_IDS.emEffQuarantined,
      filename: "em_eff_20260813_1726.mf4",
      run_id: null,
      source_system: "TAS",
      format: "MDF 4.10",
      size_bytes: 966367641,
      checksum_sha256: "6c1f9a2e07d4b8535e2a91c6f03d7b48a15e60c9d2f8b7341a0ce65d98b2f7e4",
      checksum_state: "mismatch",
      status: "quarantined",
      quarantine_reason: "Checksum mismatch against rig manifest — retained for inspection, never dropped.",
      signal_count: 0,
      time_start: "2026-08-13T17:26:00Z",
      time_end: "2026-08-13T18:44:00Z",
      registered_at: "2026-08-13T18:45:12Z",
      storage_ref: "blob://test-manager/landing/quarantine/2026/08/13/em_eff_20260813_1726.mf4",
      ingestion_job_id: "ing-20260813-1726-41d8",
      field_sources: fileSources("2026-08-13T18:45:12Z"),
    },
    {
      file_id: FILE_IDS.emEff0812,
      filename: "em_eff_20260814_0812.mf4",
      run_id: "TAS-88213",
      source_system: "TAS",
      format: "MDF 4.10",
      size_bytes: 2254857830,
      checksum_sha256: "c58d3b7a91e0f624d8c25a19b7e3046fa9d1c8e2530b6f47e19a2d0c4b8577f2",
      checksum_state: "verified",
      status: "registered",
      quarantine_reason: null,
      signal_count: 96,
      time_start: "2026-08-14T08:12:09Z",
      time_end: "2026-08-14T10:05:41Z",
      registered_at: "2026-08-14T08:12:30Z",
      storage_ref: "blob://test-manager/landing/rig-02/2026/08/14/em_eff_20260814_0812.mf4",
      ingestion_job_id: "ing-20260814-0812-19aa",
      field_sources: fileSources("2026-08-14T08:12:30Z"),
    },
    {
      file_id: FILE_IDS.invDerateQuarantined,
      filename: "inv_derate_20260812_1518.mf4",
      run_id: null,
      source_system: "INCA",
      format: "MDF 4.10",
      size_bytes: 155189248,
      checksum_sha256: "2e7d0c4a91b6f8535d3e8a12c04f9b76e2a1d5c8340f7b6e91c2d8a05e3f6b14",
      checksum_state: "unverified",
      status: "quarantined",
      quarantine_reason: "Unreadable MDF data block at offset 0x3f10 — format validation failed.",
      signal_count: 0,
      time_start: "2026-08-12T15:18:00Z",
      time_end: "2026-08-12T16:02:00Z",
      registered_at: "2026-08-12T16:03:40Z",
      storage_ref: "blob://test-manager/landing/quarantine/2026/08/12/inv_derate_20260812_1518.mf4",
      ingestion_job_id: "ing-20260812-1518-c30f",
      field_sources: fileSources("2026-08-12T16:03:40Z"),
    },
  ];
}

function seedFileSignals(): Record<string, FileSignal[]> {
  return {
    [FILE_IDS.batCyc]: [
      { name: "HV_Batt_Cell_Temp_Max", unit: "°C", unit_source: "embedded", rate_hz: 100, dtype: "float64", stats: { min: 18.2, max: 47.9, mean: 33.4, std: 6.21 } },
      { name: "HV_Batt_Pack_Voltage", unit: "V", unit_source: "embedded", rate_hz: 100, dtype: "float64", stats: { min: 312.4, max: 398.7, mean: 361.2, std: 18.4 } },
      { name: "HV_Batt_Pack_Current", unit: "A", unit_source: "embedded", rate_hz: 100, dtype: "float64", stats: { min: -214.0, max: 187.5, mean: -3.8, std: 64.02 } },
      { name: "Coolant_Inlet_Temp", unit: "°C", unit_source: "manual", rate_hz: 10, dtype: "float64", stats: { min: 15.1, max: 28.6, mean: 21.9, std: 3.12 } },
      { name: "Coolant_Flow_Rate", unit: "l/min", unit_source: "embedded", rate_hz: 10, dtype: "float64", stats: { min: 4.1, max: 12.0, mean: 8.7, std: 1.84 } },
      { name: "Chamber_Ambient_Temp", unit: "°C", unit_source: "embedded", rate_hz: 1, dtype: "float64", stats: { min: -19.8, max: 40.2, mean: 11.6, std: 17.3 } },
      { name: "HV_Batt_Cell_Temp_Min", unit: "°C", unit_source: "embedded", rate_hz: 100, dtype: "float64", stats: { min: 17.4, max: 38.6, mean: 28.9, std: 5.02 } },
      { name: "Coolant_Outlet_Temp", unit: "°C", unit_source: "embedded", rate_hz: 10, dtype: "float64", stats: { min: 16.8, max: 33.1, mean: 25.4, std: 3.9 } },
    ],
    [FILE_IDS.incaCal]: [
      { name: "HV_Batt_SOC", unit: "%", unit_source: "embedded", rate_hz: 10, dtype: "float64", stats: { min: 21.5, max: 96.0, mean: 62.3, std: 22.1 } },
      { name: "Cycle_Counter", unit: "count", unit_source: "embedded", rate_hz: 1, dtype: "int32", stats: { min: 1, max: 22, mean: 11.5, std: 6.35 } },
    ],
    [FILE_IDS.chamberLog]: [
      { name: "Chamber_Ambient_Temp", unit: "°C", unit_source: "embedded", rate_hz: 1, dtype: "float64", stats: { min: -19.8, max: 40.2, mean: 11.6, std: 17.3 } },
      { name: "Chamber_Humidity", unit: null, unit_source: null, rate_hz: 1, dtype: "float64", stats: { min: 12.1, max: 78.4, mean: 45.2, std: 14.6 } },
    ],
    [FILE_IDS.emEff0812]: [
      { name: "EM_Rotor_Temp", unit: "°C", unit_source: "embedded", rate_hz: 100, dtype: "float64", stats: { min: 24.3, max: 118.7, mean: 76.2, std: 21.4 } },
      { name: "EM_Shaft_Torque", unit: null, unit_source: null, rate_hz: 100, dtype: "float64", stats: { min: -12.4, max: 348.9, mean: 142.6, std: 88.3 } },
    ],
  };
}

function seedSignals(): SignalRecord[] {
  const embedded = (at: string): FieldSources => ({
    unit: { source: "embedded", actor: "ingestion", at },
  });
  return [
    {
      name: "HV_Batt_Cell_Temp_Max",
      description: "Hottest cell temperature across pack",
      unit: "°C",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 100,
      run_count: 12,
      first_seen: "2026-06-02T00:00:00Z",
      last_seen: "2026-08-14T09:41:33Z",
      sensor_ref: "PT100-B4-07",
      catalogue_ref: "TEMP-CELL-MAX",
      rig_ids: ["RIG-04", "RIG-07"],
      field_sources: {
        unit: { source: "embedded", actor: "ingestion", at: "2026-06-02T08:14:20Z" },
        sensor_ref: { source: "manual", actor: "a.bergstrom", at: "2026-06-03T10:02:00Z" },
        catalogue_ref: { source: "api:catalogue", actor: "catalog-sync", at: "2026-06-02T09:00:00Z" },
      },
    },
    {
      name: "HV_Batt_Cell_Temp_Min",
      description: "Coldest cell temperature across pack",
      unit: "°C",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 100,
      run_count: 12,
      first_seen: "2026-06-02T00:00:00Z",
      last_seen: "2026-08-14T09:41:33Z",
      sensor_ref: null,
      catalogue_ref: "TEMP-CELL-MIN",
      rig_ids: ["RIG-04"],
      field_sources: embedded("2026-06-02T08:14:20Z"),
    },
    {
      name: "HV_Batt_Pack_Voltage",
      description: "Pack terminal voltage",
      unit: "V",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 100,
      run_count: 12,
      first_seen: "2026-06-02T00:00:00Z",
      last_seen: "2026-08-14T09:41:33Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-04"],
      field_sources: embedded("2026-06-02T08:14:20Z"),
    },
    {
      name: "HV_Batt_Pack_Current",
      description: "Pack current, discharge negative",
      unit: "A",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 100,
      run_count: 12,
      first_seen: "2026-06-02T00:00:00Z",
      last_seen: "2026-08-14T09:41:33Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-04"],
      field_sources: embedded("2026-06-02T08:14:20Z"),
    },
    {
      name: "HV_Batt_SOC",
      description: "State of charge, BMS estimate",
      unit: "%",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 10,
      run_count: 12,
      first_seen: "2026-06-02T00:00:00Z",
      last_seen: "2026-08-14T09:41:33Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-04"],
      field_sources: embedded("2026-06-02T08:14:20Z"),
    },
    {
      name: "Coolant_Inlet_Temp",
      description: "Coolant temperature at pack inlet",
      unit: "°C",
      unit_source: "manual",
      dtype: "float64",
      typical_rate_hz: 10,
      run_count: 8,
      first_seen: "2026-06-18T00:00:00Z",
      last_seen: "2026-08-14T09:41:33Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-04"],
      field_sources: {
        unit: { source: "manual", actor: "a.bergstrom", at: "2026-08-14T10:12:00Z" },
      },
    },
    {
      name: "Coolant_Outlet_Temp",
      description: "Coolant temperature at pack outlet",
      unit: "°C",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 10,
      run_count: 8,
      first_seen: "2026-06-18T00:00:00Z",
      last_seen: "2026-08-14T09:41:33Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-04"],
      field_sources: embedded("2026-06-18T09:30:00Z"),
    },
    {
      name: "Coolant_Flow_Rate",
      description: "Volumetric flow, conditioning loop",
      unit: "l/min",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 10,
      run_count: 8,
      first_seen: "2026-06-18T00:00:00Z",
      last_seen: "2026-08-14T09:41:33Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-04"],
      field_sources: embedded("2026-06-18T09:30:00Z"),
    },
    {
      name: "Chamber_Ambient_Temp",
      description: "Climate chamber air temperature",
      unit: "°C",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 1,
      run_count: 21,
      first_seen: "2026-06-02T00:00:00Z",
      last_seen: "2026-08-14T09:42:18Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-04", "RIG-07"],
      field_sources: embedded("2026-06-02T08:14:20Z"),
    },
    {
      name: "Chamber_Humidity",
      description: "Climate chamber relative humidity",
      unit: null,
      unit_source: null,
      dtype: "float64",
      typical_rate_hz: 1,
      run_count: 21,
      first_seen: "2026-06-02T00:00:00Z",
      last_seen: "2026-08-14T09:42:18Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-04", "RIG-07"],
      field_sources: {},
    },
    {
      name: "EM_Rotor_Temp",
      description: "E-machine rotor temperature, estimated",
      unit: "°C",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 100,
      run_count: 9,
      first_seen: "2026-06-05T00:00:00Z",
      last_seen: "2026-08-14T08:12:30Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-02"],
      field_sources: embedded("2026-06-05T07:50:00Z"),
    },
    {
      name: "EM_Shaft_Torque",
      description: "Dyno shaft torque, HBM flange",
      unit: null,
      unit_source: null,
      dtype: "float64",
      typical_rate_hz: 100,
      run_count: 9,
      first_seen: "2026-06-05T00:00:00Z",
      last_seen: "2026-08-14T08:12:30Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-02"],
      field_sources: {},
    },
    {
      name: "INV_DC_Bus_Voltage",
      description: "Inverter DC-link voltage",
      unit: "V",
      unit_source: "embedded",
      dtype: "float64",
      typical_rate_hz: 100,
      run_count: 6,
      first_seen: "2026-06-11T00:00:00Z",
      last_seen: "2026-08-13T17:26:41Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-07"],
      field_sources: embedded("2026-06-11T13:20:00Z"),
    },
    {
      name: "Cycle_Counter",
      description: "Test sequence cycle index",
      unit: "count",
      unit_source: "embedded",
      dtype: "int32",
      typical_rate_hz: 1,
      run_count: 14,
      first_seen: "2026-06-02T00:00:00Z",
      last_seen: "2026-08-14T09:42:05Z",
      sensor_ref: null,
      catalogue_ref: null,
      rig_ids: ["RIG-02", "RIG-04", "RIG-07"],
      field_sources: embedded("2026-06-02T08:14:20Z"),
    },
  ];
}

function seedSignalRunStats(): Record<string, StoredRunStat[]> {
  return {
    HV_Batt_Cell_Temp_Max: [
      { run_id: "TAS-88214", min: 18.2, max: 47.9, mean: 33.4, std: 6.21 },
      { run_id: "TAS-88207", min: 19.4, max: 46.2, mean: 32.8, std: 5.98 },
      { run_id: "TAS-88198", min: 21.0, max: 48.3, mean: 34.9, std: 6.4 },
      { run_id: "TAS-88190", min: 24.6, max: 49.7, mean: 38.2, std: 5.7 },
      { run_id: "TAS-88183", min: 25.1, max: 49.4, mean: 37.6, std: 5.5 },
      { run_id: "TAS-88177", min: 23.8, max: 48.9, mean: 36.4, std: 5.8 },
      { run_id: "TAS-88168", min: 24.2, max: 47.6, mean: 36.9, std: 5.6 },
      { run_id: "TAS-88159", min: 15.8, max: 44.1, mean: 29.6, std: 6.9 },
      { run_id: "TAS-88150", min: 16.3, max: 43.5, mean: 30.2, std: 6.7 },
      { run_id: "TAS-88141", min: 22.7, max: 46.8, mean: 35.1, std: 5.9 },
      { run_id: "TAS-88123", min: 15.2, max: 42.8, mean: 28.9, std: 7.0 },
      { run_id: "TAS-88104", min: 16.1, max: 43.9, mean: 29.8, std: 6.8 },
    ],
  };
}

function seedResults(): ProcessedResult[] {
  return [
    {
      result_id: RESULT_ID,
      run_id: HERO_RUN_ID,
      name: "thermal_summary_v1.parquet",
      result_key: "thermal_summary",
      version: 1,
      supersedes: null,
      description: "Cycle-level aggregates",
      storage_ref: "blob://results/tas-88214/thermal_summary_v1.parquet",
      provenance: {
        tool: "bat-post",
        tool_version: "2.3.1",
        parameters: "--cycles all --dt 0.1",
        input_file_ids: [FILE_IDS.batCyc, FILE_IDS.chamberLog],
        produced_by: "e.lindqvist",
        produced_at: "2026-08-14T12:02:00Z",
      },
      provenance_status: "verified",
      created_at: "2026-08-14T12:02:31Z",
    },
  ];
}

function seedJournal(): JournalRecord[] {
  return [
    {
      id: "j-4c2e91a7-05d8-4b36-9f12-e7a80c4d5b19",
      entity_type: "signal",
      entity_id: "Coolant_Inlet_Temp",
      field: "signal.Coolant_Inlet_Temp.unit",
      kind: "change",
      old: "(missing)",
      new: "°C",
      source: "manual",
      actor: "a.bergstrom",
      note: "Unit absent from file header — set from rig sensor sheet.",
      at: "2026-08-14T10:12:00Z",
      context_run_id: HERO_RUN_ID,
    },
    {
      id: "j-8b3d02f6-71c4-4e95-a2d8-0c1f6e94a752",
      entity_type: "run",
      entity_id: HERO_RUN_ID,
      field: "run.operator",
      kind: "change",
      old: "(empty)",
      new: "A. Bergström",
      source: "manual",
      actor: "a.bergstrom",
      note: null,
      at: "2026-08-14T09:58:00Z",
    },
    {
      id: "j-1f60e8d3-92a5-4c07-b4e1-5d28a7c39f84",
      entity_type: "run",
      entity_id: HERO_RUN_ID,
      field: "run.registered",
      kind: "event",
      old: null,
      new: null,
      source: "embedded",
      actor: "ingestion",
      note: "Run created automatically — 3 files parsed, 142 signals cataloged, checksums verified.",
      at: "2026-08-14T09:41:33Z",
    },
    {
      id: "j-a95c17e0-3b64-4d28-8f0a-c2e51d97b346",
      entity_type: "file",
      entity_id: FILE_IDS.batCyc,
      field: "file.detected",
      kind: "event",
      old: null,
      new: null,
      source: "embedded",
      actor: "ingestion",
      note: "bat_cyc_20260814_0941.mf4 arrived through mf4-import.",
      at: "2026-08-14T09:41:12Z",
    },
    {
      id: "j-d27f04b8-6e19-4a53-92c7-1b8e0f5a4d62",
      entity_type: "file",
      entity_id: FILE_IDS.batCyc,
      field: "file.checksum_verified",
      kind: "event",
      old: null,
      new: null,
      source: "embedded",
      actor: "ingestion",
      note: "sha256 matches manifest — file admitted for parsing.",
      at: "2026-08-14T09:41:19Z",
    },
    {
      id: "j-63a8f2c1-0d97-4e46-b5a3-9f14c6d20e78",
      entity_type: "file",
      entity_id: FILE_IDS.batCyc,
      field: "file.header_parsed",
      kind: "event",
      old: null,
      new: null,
      source: "embedded",
      actor: "ingestion",
      note: "MDF 4.10 header read — 96 signals cataloged with units and rates.",
      at: "2026-08-14T09:41:31Z",
    },
    {
      id: "j-05e9b7d4-8a12-4f60-93c8-6d2a1e0f7b45",
      entity_type: "file",
      entity_id: FILE_IDS.batCyc,
      field: "file.registered",
      kind: "event",
      old: null,
      new: null,
      source: "embedded",
      actor: "ingestion",
      note: "Linked to run TAS-88214 (idempotent upsert).",
      at: "2026-08-14T09:41:33Z",
    },
    {
      // The planning mirror is the only writer of a definition entry. It
      // journals one `mirrored` event on arrival, then one change per field
      // planning moved (`api/api/planning_sync.py`).
      id: "j-2d84c0f5-63b1-4a97-8e35-71f0a9c4d268",
      entity_type: "test_definition",
      entity_id: SYNC_TD_ID,
      field: "test_definition.planned_runs",
      kind: "change",
      old: "2",
      new: "4",
      source: "api:planning",
      actor: "planning-sync",
      note: "Changed by planning.",
      at: "2026-08-13T07:44:00Z",
    },
    {
      id: "j-7f19b6a2-54d0-4c83-91e6-3a5c8d20f74b",
      entity_type: "test_definition",
      entity_id: SYNC_TD_ID,
      field: "test_definition.mirrored",
      kind: "event",
      old: null,
      new: null,
      source: "api:planning",
      actor: "planning-sync",
      note: "Mirrored from planning.",
      at: "2026-08-11T06:30:00Z",
    },
    {
      id: "j-e71b39a6-2c50-4d84-a1f7-08d6c4e29b53",
      entity_type: "run",
      entity_id: "TAS-88209",
      field: "run.invalid_flag",
      kind: "change",
      old: "false",
      new: "true",
      source: "manual",
      actor: "e.lindqvist",
      note: "Torque ripple sensor fault from cycle 6 — derating sweep data unusable.",
      at: "2026-08-13T18:02:00Z",
    },
  ];
}

export function createSeedState(): MockState {
  return {
    planningOnline: false,
    lastSyncAt: null,
    lastSyncResult: null,
    runs: seedRuns(),
    workOrders: seedWorkOrders(),
    definitions: seedDefinitions(),
    woDefinitions: seedWoDefinitions(),
    files: seedFiles(),
    fileSignals: seedFileSignals(),
    signals: seedSignals(),
    signalRunStats: seedSignalRunStats(),
    results: seedResults(),
    journal: seedJournal(),
  };
}
