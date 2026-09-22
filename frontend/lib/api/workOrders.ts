import type {
  JournalEntry,
  JournalKind,
  PageParams,
  Paginated,
  WorkOrderDetail,
  WorkOrderFacets,
  WorkOrderListFilters,
  WorkOrderListResponse,
} from "@/types";
import { api } from "./client";

export const workOrdersApi = {
  list: (filters: WorkOrderListFilters = {}) =>
    api.get<WorkOrderListResponse>("/work-orders", { ...filters }),
  facets: () => api.get<WorkOrderFacets>("/work-orders/facets"),
  get: (woId: string) => api.get<WorkOrderDetail>(`/work-orders/${encodeURIComponent(woId)}`),
  /** The work order's own history — contract §8b. Same shape as the run journal. */
  journal: (woId: string, params: PageParams & { kind?: JournalKind } = {}) =>
    api.get<Paginated<JournalEntry>>(`/work-orders/${encodeURIComponent(woId)}/journal`, {
      ...params,
    }),
};
