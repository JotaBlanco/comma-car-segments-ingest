import type {
  FileDetail,
  FileEntity,
  FileLifecycleBody,
  FileListFilters,
  FileListResponse,
  FileVersionListResponse,
  FileVersionRegisterBody,
  InvalidFlagBody,
  JournalEntry,
  JournalKind,
  PageParams,
  Paginated,
  StageStatus,
} from "@/types";
import { api } from "./client";
import { fetchDownload, type DownloadOutcome } from "./download";

/**
 * The outcome of a successful file download. It is the shared download shape;
 * the alias stays because callers and tests name it.
 */
export type FileDownload = DownloadOutcome;

/**
 * Body of `PATCH /files/{file_id}` — see `FilePatchRequest` in
 * `api/api/models/files.py`.
 *
 * A person states the run link by hand (the quarantine repair, TR-003), or the
 * pipeline reports a later stage outcome. The model sets `extra="forbid"`, so
 * this shape offers these keys and no other. A field sent as null counts as
 * absent on the server, so the body cannot clear a value.
 */
export interface FilePatchBody {
  run_id?: string;
  sync_status?: StageStatus;
  upload_status?: StageStatus;
  conversion_status?: StageStatus;
  stage_error?: string;
  actor: string;
  note?: string;
}

export const filesApi = {
  list: (filters: FileListFilters = {}) =>
    api.get<FileListResponse>("/files", { ...filters }),
  get: (fileId: string, signalsLimit?: number) =>
    api.get<FileDetail>(`/files/${encodeURIComponent(fileId)}`, { signals_limit: signalsLimit }),
  /** The file's own history — contract §8b. Same shape as the run journal. */
  journal: (fileId: string, params: PageParams & { kind?: JournalKind } = {}) =>
    api.get<Paginated<JournalEntry>>(`/files/${encodeURIComponent(fileId)}/journal`, {
      ...params,
    }),
  /**
   * Link one file to a run by hand, or report a stage outcome —
   * `PATCH /files/{file_id}`.
   *
   * This is the quarantine repair (TR-003). A file quarantined for "no run
   * key" leaves quarantine when a person states the link, because the missing
   * link was the reason it was refused. An unknown run answers 422
   * `unknown_run`, and an archived or deleted file answers 409 — a person
   * restores it first, then edits it.
   */
  patch: (fileId: string, body: FilePatchBody) =>
    api.patch<FileDetail>(`/files/${encodeURIComponent(fileId)}`, body),
  /**
   * Move one file out of the daily table — `POST /files/{id}/archive`.
   * The file keeps every byte and it still downloads.
   */
  archive: (fileId: string, body: FileLifecycleBody) =>
    api.post<FileDetail>(`/files/${encodeURIComponent(fileId)}/archive`, body),
  /** Bring one archived or deleted file back — `POST /files/{id}/restore`. */
  restore: (fileId: string, body: FileLifecycleBody) =>
    api.post<FileDetail>(`/files/${encodeURIComponent(fileId)}/restore`, body),
  /**
   * Soft-delete one file — `DELETE /files/{id}`.
   *
   * The route writes `lifecycle: "deleted"` and nothing else. It keeps every
   * byte and it keeps the storage reference, so a restore brings the file
   * back. This is never a permanent delete.
   */
  remove: (fileId: string, body: FileLifecycleBody) =>
    api.delete<FileDetail>(`/files/${encodeURIComponent(fileId)}`, body),
  /**
   * Mark one file invalid — `POST /files/{id}/invalid-flag`.
   *
   * It is the run route of the same name, read at file level. Both writes need
   * a reason, a blank reason answers 422 `reason_required`, and each write
   * lands in the file's own timeline as `file.invalid_flag`. The mark touches
   * the file alone: `status` never moves, and the run never moves.
   */
  flagInvalid: (fileId: string, body: InvalidFlagBody) =>
    api.post<FileDetail>(`/files/${encodeURIComponent(fileId)}/invalid-flag`, body),
  /** Take the mark back — `DELETE /files/{id}/invalid-flag`. */
  clearInvalid: (fileId: string, body: InvalidFlagBody) =>
    api.delete<FileDetail>(`/files/${encodeURIComponent(fileId)}/invalid-flag`, body),
  /**
   * The whole version chain — `GET /files/{id}/versions`, oldest first.
   * Any version of the chain serves the same history, and every lifecycle
   * shows, because the history is the audit trail of the file.
   */
  versions: (fileId: string) =>
    api.get<FileVersionListResponse>(`/files/${encodeURIComponent(fileId)}/versions`),
  /**
   * Register a new version — `POST /files/{id}/versions`.
   *
   * Every version is a whole file document with its own id, its own checksum
   * and its own download, so a version overwrites no byte and no record.
   */
  registerVersion: (fileId: string, body: FileVersionRegisterBody) =>
    api.post<FileEntity>(`/files/${encodeURIComponent(fileId)}/versions`, body),
  /**
   * Download one file through the server-side proxy so the Authorization
   * header stays server-side (the browser never holds the API token). The
   * caller receives a Blob it can hand to a hidden `<a>` element for the
   * download. Errors surface as ApiError with the BE code and detail —
   * "storage_unreachable" is the shape the UI translates into "Storage
   * unreachable — download is available in the deployed environment".
   *
   * The call states the viewer's own Portal token, as `api.get` does. Without
   * it the proxy fell back to the shared token, and the audit row named "static
   * token holder" for a download a person took. A download is the one call that
   * writes an audit row about a person, so it must never be the one call that
   * hides the person.
   */
  download: (fileId: string, fallbackFilename: string): Promise<FileDownload> =>
    fetchDownload(`/files/${encodeURIComponent(fileId)}/download`, fallbackFilename),
};
