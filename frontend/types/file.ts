import type { ItemsEnvelope, PageParams, Paginated, SortOrder, ViewCounts } from "./common";
import type { JournalEntry } from "./journal";
import type { InvalidFlag } from "./test-run";
import type { FieldSources } from "./source";
import type { FileSignal } from "./signal";

export type FileStatus = "registered" | "quarantined";

/**
 * What a person did with the record, and never what the registry thinks of
 * the bytes. `lifecycle` and `status` are two separate fields
 * (`api/api/models/files.py`), so a screen shows two separate badges.
 *
 * `deleted` is a soft delete. The route writes the field and nothing else: it
 * keeps every byte and it keeps `storage_ref`, the download answers 410, and a
 * restore brings the file back. Never word a control as a permanent delete.
 */
export type FileLifecycle = "active" | "archived" | "deleted";

/**
 * The outcome of one ingestion stage (FR-DM-006b). The pipeline runs the sync,
 * the upload and the conversion outside the registry and reports each outcome
 * here. An absent value means no stage report arrived, so a screen reads it as
 * unknown and never as failed.
 */
export type StageStatus = "pending" | "in_progress" | "success" | "failed";

/** Sortable column keys for `GET /files` (see contract §2.3). */
export type FileSortKey = "registered_at" | "size_bytes";

export type ChecksumState = "verified" | "mismatch" | "unverified";

/* "api" marks a logical file minted by POST /test-runs/{id}/signals — the
   backend default for machine submissions (api/api/models/files.py). */
export type SourceSystem = "TAS" | "INCA" | "ifile" | "api";

export interface FileEntity {
  file_id: string;
  filename: string;
  run_id: string | null;
  source_system: SourceSystem;
  format: string;
  size_bytes: number;
  checksum_sha256: string;
  checksum_state: ChecksumState;
  status: FileStatus;
  quarantine_reason: string | null;
  /* The six fields below arrived on 20 Aug 2026. A file the registry stored
     before that date carries none of them, so each one is optional and a
     screen falls back to "active", "version 1" and "no stage report". */
  lifecycle?: FileLifecycle;
  version?: number;
  sync_status?: StageStatus | null;
  upload_status?: StageStatus | null;
  conversion_status?: StageStatus | null;
  stage_error?: string | null;
  /* The invalid mark at file level, added 24 Aug 2026. It is the identical
     block the run carries, because the requirement asks for the mark on the
     container AND the file. It is never a `status` value: `status` stays the
     verdict of the registry about the bytes. A file the registry stored before
     that date carries no block, so a screen reads an absent block as clear. */
  invalid?: InvalidFlag;
  signal_count: number;
  time_start: string | null;
  time_end: string | null;
  registered_at: string;
  /* The physical car the recording came off, claimed on upload or stated in
     the MF4 header. Optional: a file registered before the field existed, and
     one whose producer named no car, both arrive without it. */
  vehicle?: string | null;
}

export interface FileDetail extends FileEntity {
  storage_ref: string | null;
  ingestion_job_id: string | null;
  field_sources: FieldSources;
  ingestion_timeline: JournalEntry[];
  signals: FileSignal[];
  /** The file id this version supersedes — the link the version chain walks. */
  supersedes?: string | null;
}

export type FileListFilters = PageParams & {
  status?: readonly FileStatus[];
  source_system?: readonly SourceSystem[];
  /**
   * The named view of the table. No value asks for the plain table, which
   * holds the active files only, so an archived file and a deleted file both
   * stay out of it (`api/api/routers/files.py`).
   */
  lifecycle?: readonly FileLifecycle[];
  run?: string;
  unlinked?: boolean;
  /**
   * The invalid mark. `true` serves the marked files, `false` serves the rest,
   * and no value serves both — the mark hides no row.
   */
  invalid?: boolean;
  q?: string;
  sort?: FileSortKey;
  order?: SortOrder;
};

/**
 * Whole-table, filter-independent quick-view counts for `GET /files`.
 * `all`, `registered` and `quarantined` count the files nobody deleted.
 * `deleted` counts the recycle bin (contract §12).
 */
export type FileViewCounts = ViewCounts & {
  all: number;
  registered: number;
  quarantined: number;
  archived: number;
  deleted: number;
};

export interface FileListResponse extends Paginated<FileEntity> {
  /** Whole-table quick-view counts (optional, filter-independent). */
  view_counts?: FileViewCounts;
}

/**
 * The body the three lifecycle routes take: `DELETE /files/{id}`,
 * `POST /files/{id}/archive` and `POST /files/{id}/restore`.
 *
 * A person states the change, so the actor is required and the journal entry
 * carries the `manual` tag.
 */
export interface FileLifecycleBody {
  actor: string;
  note?: string;
}

/**
 * The body `POST /files/{file_id}/versions` takes.
 *
 * A version is a whole file: it carries its own bytes, its own checksum and
 * its own storage reference, so the body repeats the registration shape. A
 * body that names no run inherits the run of the newest version.
 */
export interface FileVersionRegisterBody {
  filename: string;
  source_system: SourceSystem;
  format: string;
  size_bytes: number;
  checksum_sha256: string;
  storage_ref?: string | null;
  actor: string;
  note?: string;
}

/** The answer of `GET /files/{file_id}/versions` — oldest first. */
export type FileVersionListResponse = ItemsEnvelope<FileEntity>;
