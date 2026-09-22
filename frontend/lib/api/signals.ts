import type {
  JournalEntry,
  JournalKind,
  PageParams,
  Paginated,
  SignalDetail,
  SignalFacets,
  SignalListFilters,
  SignalListResponse,
  SignalPatchBody,
  SignalRunStatsResponse,
  SignalStatsFilters,
} from "@/types";
import { api } from "./client";

export const signalsApi = {
  list: (filters: SignalListFilters = {}) =>
    api.get<SignalListResponse>("/signals", { ...filters }),
  facets: () => api.get<SignalFacets>("/signals/facets"),
  get: (name: string) => api.get<SignalDetail>(`/signals/${encodeURIComponent(name)}`),
  /** The signal's own history — contract §8b. Same shape as the run journal. */
  journal: (name: string, params: PageParams & { kind?: JournalKind } = {}) =>
    api.get<Paginated<JournalEntry>>(`/signals/${encodeURIComponent(name)}/journal`, {
      ...params,
    }),
  patch: (name: string, body: SignalPatchBody) =>
    api.patch<SignalDetail>(`/signals/${encodeURIComponent(name)}`, body),
  runStats: (name: string, filters: SignalStatsFilters = {}) =>
    api.get<SignalRunStatsResponse>(`/signals/${encodeURIComponent(name)}/stats`, {
      window: "run",
      ...filters,
    }),
};
