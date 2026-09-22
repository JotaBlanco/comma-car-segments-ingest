import type {
  JournalEntry,
  JournalKind,
  PageParams,
  Paginated,
  RequirementCreateBody,
  RequirementDetail,
  RequirementFacets,
  RequirementListFilters,
  RequirementPage,
  RequirementPatchBody,
  RequirementRetireBody,
} from "@/types";
import { api } from "./client";

export const requirementsApi = {
  list: (filters: RequirementListFilters = {}) =>
    api.get<RequirementPage>("/requirements", { ...filters }),
  facets: () => api.get<RequirementFacets>("/requirements/facets"),
  get: (reqId: string) =>
    api.get<RequirementDetail>(`/requirements/${encodeURIComponent(reqId)}`),
  /** The requirement's own history — contract §8b, same shape as every
      other entity journal. */
  journal: (reqId: string, params: PageParams & { kind?: JournalKind } = {}) =>
    api.get<Paginated<JournalEntry>>(`/requirements/${encodeURIComponent(reqId)}/journal`, {
      ...params,
    }),
  /** Manual only — a planning-sourced row is edited in planning, not here
      (authoring-controls §3). */
  create: (body: RequirementCreateBody) => api.post<RequirementDetail>("/requirements", body),
  patch: (reqId: string, body: RequirementPatchBody) =>
    api.patch<RequirementDetail>(`/requirements/${encodeURIComponent(reqId)}`, body),
  /** Retire, never delete — the row and its id stay, `status` moves to
      `Obsolete` (authoring-controls §5). Works on either origin. */
  retire: (reqId: string, body: RequirementRetireBody) =>
    api.post<RequirementDetail>(`/requirements/${encodeURIComponent(reqId)}/retire`, body),
};
