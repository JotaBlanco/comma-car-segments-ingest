import type {
  DefinitionCustomProperties,
  DefinitionCustomPropertiesBody,
  JournalEntry,
  JournalKind,
  PageParams,
  Paginated,
  RequirementsFile,
  RequirementsFileCreate,
  RequirementsFileEdit,
  TestDefinitionDetail,
  TestDefinitionListFilters,
  TestDefinitionListResponse,
} from "@/types";
import { api } from "./client";
import { type DownloadOutcome, fetchDownload } from "./download";

/** The requirements-files collection of one definition. */
function requirementsPath(tdId: string): string {
  return `/test-definitions/${encodeURIComponent(tdId)}/requirements-files`;
}

export const testDefinitionsApi = {
  list: (filters: TestDefinitionListFilters = {}) =>
    api.get<TestDefinitionListResponse>("/test-definitions", { ...filters }),
  get: (tdId: string) =>
    api.get<TestDefinitionDetail>(`/test-definitions/${encodeURIComponent(tdId)}`),
  /** The definition's own history — contract §8b. Same shape as the run journal. */
  journal: (tdId: string, params: PageParams & { kind?: JournalKind } = {}) =>
    api.get<Paginated<JournalEntry>>(`/test-definitions/${encodeURIComponent(tdId)}/journal`, {
      ...params,
    }),
  /** Add one requirements document. It always carries the source `manual`. */
  addRequirementsFile: (tdId: string, body: RequirementsFileCreate) =>
    api.post<RequirementsFile>(requirementsPath(tdId), body),
  /**
   * Change the text of one manual TEXT document, and the markdown flag with
   * it. The path names the document, so this never renames one. The API
   * refuses a planning document and a binary document.
   */
  editRequirementsFile: (tdId: string, name: string, body: RequirementsFileEdit) =>
    api.patch<RequirementsFile>(
      `${requirementsPath(tdId)}/${encodeURIComponent(name)}`,
      body,
    ),
  /**
   * Remove one manual requirements document. The API refuses a planning
   * document. It answers no body, so this goes through `deleteVoid`, which
   * reads the status and never parses an empty answer.
   */
  removeRequirementsFile: (tdId: string, name: string) =>
    api.deleteVoid(`${requirementsPath(tdId)}/${encodeURIComponent(name)}`, undefined),
  /**
   * Replace the custom property map. The map goes whole, never a merge, so an
   * empty object clears every property. The stored map always reads `manual`.
   */
  setCustomProperties: (tdId: string, body: DefinitionCustomPropertiesBody) =>
    api.patch<DefinitionCustomProperties>(
      `/test-definitions/${encodeURIComponent(tdId)}/custom-properties`,
      body,
    ),
  /**
   * Add one BINARY requirements document — a PDF, a Word file, a spreadsheet
   * or an image. It posts `multipart/form-data` through the same proxy the
   * result upload uses, so the browser picks the boundary and the API token
   * stays on the server. An absent name takes the filename.
   */
  uploadRequirementsFileBytes: (tdId: string, file: File, name?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (name !== undefined && name.length > 0) form.append("name", name);
    return api.postForm<RequirementsFile>(`${requirementsPath(tdId)}/upload`, form);
  },
  /**
   * Fetch the bytes of one binary requirements document.
   *
   * It goes through the server-side proxy, so **no token ever reaches the
   * URL**. The API writes the audit entry before the first byte leaves.
   *
   * Errors surface as `ApiError` with the BE code:
   * `requirements_file_not_found` (404), `requirements_file_has_no_bytes`
   * (409) on a text document, `storage_unreachable` (503) when the store did
   * not answer, `not_ready` (503) when the audit write failed.
   */
  downloadRequirementsFile: (tdId: string, name: string): Promise<DownloadOutcome> =>
    fetchDownload(
      `${requirementsPath(tdId)}/${encodeURIComponent(name)}/download`,
      name,
    ),
};
