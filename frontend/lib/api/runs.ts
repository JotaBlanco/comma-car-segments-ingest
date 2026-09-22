import type {
  FileEntity,
  InvalidFlagBody,
  ItemsEnvelope,
  JournalEntry,
  JournalKind,
  LineageResponse,
  NoteCreateBody,
  PageParams,
  Paginated,
  RunFacets,
  RunGroupFilters,
  RunGroupPage,
  RunListFilters,
  RunListResponse,
  RunDeleteBody,
  RunDeletionReport,
  RunPatchBody,
  RunSignalPage,
  TestRun,
} from "@/types";
import { api } from "./client";

export const runsApi = {
  list: (filters: RunListFilters = {}) =>
    api.get<RunListResponse>("/test-runs", { ...filters }),
  facets: () => api.get<RunFacets>("/test-runs/facets"),
  /* Contract §2c. A separate route, so `list` keeps the pinned shape. Every
     filter rides along, so the counts belong to the same rows `list` returns. */
  groups: (filters: RunGroupFilters) =>
    api.get<RunGroupPage>("/test-runs/groups", { ...filters }),
  get: (runId: string) =>
    api.get<TestRun>(`/test-runs/${encodeURIComponent(runId)}`),
  patch: (runId: string, body: RunPatchBody) =>
    api.patch<TestRun>(`/test-runs/${encodeURIComponent(runId)}`, body),
  /* A hard delete. The run, its files and their bytes, its signal rows, its
     results and the samples QuixLake holds under the run's partition folder
     all go; the journal keeps every entry and gains a `run.deleted` one. There
     is no undo, so only a typed confirmation reaches this call. */
  remove: (runId: string, body: RunDeleteBody) =>
    api.delete<RunDeletionReport>(`/test-runs/${encodeURIComponent(runId)}`, body),
  flagInvalid: (runId: string, body: InvalidFlagBody) =>
    api.post<TestRun>(
      `/test-runs/${encodeURIComponent(runId)}/invalid-flag`,
      body,
    ),
  clearInvalid: (runId: string, body: InvalidFlagBody) =>
    api.delete<TestRun>(
      `/test-runs/${encodeURIComponent(runId)}/invalid-flag`,
      body,
    ),
  addNote: (runId: string, body: NoteCreateBody) =>
    api.post<JournalEntry>(
      `/test-runs/${encodeURIComponent(runId)}/journal`,
      body,
    ),
  /* A page at a time: one sortie registers 720 chunk files, and the tab that
     lists them refetches every ten seconds. Naming no page still answers with
     every file, which is the route's contract. */
  files: (runId: string, params: PageParams = {}) =>
    api.get<ItemsEnvelope<FileEntity>>(
      `/test-runs/${encodeURIComponent(runId)}/files`,
      {
        ...params,
      },
    ),
  signals: (runId: string, params: PageParams = {}) =>
    api.get<RunSignalPage>(`/test-runs/${encodeURIComponent(runId)}/signals`, {
      ...params,
    }),
  journal: (runId: string, params: PageParams & { kind?: JournalKind } = {}) =>
    api.get<Paginated<JournalEntry>>(
      `/test-runs/${encodeURIComponent(runId)}/journal`,
      { ...params },
    ),
  lineage: (runId: string) =>
    api.get<LineageResponse>(`/test-runs/${encodeURIComponent(runId)}/lineage`),
};
