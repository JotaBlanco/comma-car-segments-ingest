import type { FormAnswer } from "./client";
import type {
  JournalEntry,
  JournalKind,
  PageParams,
  Paginated,
  ProcessedResult,
  Provenance,
  ResultListFilters,
  ResultPatchBody,
} from "@/types";
import { api } from "./client";
import { fetchDownload, type DownloadOutcome } from "./download";

/**
 * The `metadata` part of `POST /results/upload`.
 *
 * It is the `POST /results` body minus `storage_ref`. The server mints that
 * reference from the key it writes, so a metadata part that carries one
 * answers 422 `storage_ref_not_allowed`. See the result-upload box (v1.2) in
 * `plans/API-CONTRACT.md`.
 */
export interface ResultUploadMetadata {
  run_id: string;
  name: string;
  result_key: string;
  description: string | null;
  provenance: Provenance;
}

export const resultsApi = {
  list: (filters: ResultListFilters = {}) =>
    api.get<Paginated<ProcessedResult>>("/results", { ...filters }),

  /**
   * One result version, by its own id — `GET /results/{result_id}` (§B #18b).
   *
   * A list answers "which versions exist"; this answers "this one". The body
   * is the same `ProcessedResult` the list serves. An unknown id answers 404
   * `result_not_found`.
   */
  get: (resultId: string) =>
    api.get<ProcessedResult>(`/results/${encodeURIComponent(resultId)}`),

  /**
   * Edit one result — `PATCH /results/{result_id}`.
   *
   * The answer is the stored `ProcessedResult`, and it carries the `edited`
   * mark the screens print. The route refuses an empty body with 400
   * `no_fields_to_update`, an unknown id with 404 `result_not_found`, a blank
   * provenance value with 422 `provenance_required` and a refused value with
   * 422 `validation_error`.
   */
  patch: (resultId: string, body: ResultPatchBody) =>
    api.patch<ProcessedResult>(`/results/${encodeURIComponent(resultId)}`, body),

  /**
   * One result's history — `GET /results/{result_id}/journal` (TR-012).
   *
   * The same shape every other entity journal serves: newest first, the same
   * `kind` filter and the same `Page[JournalEntry]` envelope
   * (`api/api/routers/journal.py`). An unknown id answers 404
   * `result_not_found`, never an empty page — an empty page means "nothing
   * happened yet" and it means nothing else.
   */
  journal: (resultId: string, params: PageParams & { kind?: JournalKind } = {}) =>
    api.get<Paginated<JournalEntry>>(`/results/${encodeURIComponent(resultId)}/journal`, {
      ...params,
    }),

  /**
   * The stored bytes of one result — `GET /results/{result_id}/download`
   * (§B #18c).
   *
   * It goes through the server-side proxy, so the API token stays on the
   * server and **no token ever reaches the URL**. The server writes the
   * `result.downloaded` audit entry before the first byte leaves.
   *
   * Errors surface as `ApiError` with the BE code: `result_has_no_bytes` (409)
   * when the result names no storage reference, `storage_unreachable` (503)
   * when the store did not answer, `not_ready` (503) when the audit write
   * failed. The result download carries no `X-Checksum-State`, so
   * `checksumState` reads null: no check ever runs on a result's bytes.
   */
  download: (resultId: string, fallbackFilename: string): Promise<DownloadOutcome> =>
    fetchDownload(`/results/${encodeURIComponent(resultId)}/download`, fallbackFilename),

  /** Upload the bytes and the metadata of one processed result. */
  upload: (file: File, metadata: ResultUploadMetadata): Promise<FormAnswer<ProcessedResult>> => {
    const form = new FormData();
    form.append("file", file);
    form.append("metadata", JSON.stringify(metadata));
    return api.postForm<ProcessedResult>("/results/upload", form);
  },
};
