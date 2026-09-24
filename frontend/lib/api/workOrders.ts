import type {
  JournalEntry,
  JournalKind,
  PageParams,
  Paginated,
  WorkOrderCreateBody,
  WorkOrderDeletionReport,
  WorkOrderDetail,
  WorkOrderFacets,
  WorkOrderListFilters,
  WorkOrderListResponse,
  WorkOrderStatusBody,
} from "@/types";
import { api } from "./client";

export const workOrdersApi = {
  list: (filters: WorkOrderListFilters = {}) =>
    api.get<WorkOrderListResponse>("/work-orders", { ...filters }),
  facets: () => api.get<WorkOrderFacets>("/work-orders/facets"),
  /* A campaign planning never knew about. The row is written at `manual`. */
  create: (body: WorkOrderCreateBody) =>
    api.post<WorkOrderDetail>("/work-orders", body),
  get: (woId: string) => api.get<WorkOrderDetail>(`/work-orders/${encodeURIComponent(woId)}`),
  /* The status alone: `closed` ends the campaign, `active` reopens it. The
     body names no actor — the API reads the viewer's Portal token. */
  setStatus: (woId: string, body: WorkOrderStatusBody) =>
    api.patch<WorkOrderDetail>(`/work-orders/${encodeURIComponent(woId)}`, body),
  /* A hard delete: the work order and the test definitions under it. A work
     order any test run names is refused 409 `work_order_has_runs`. */
  remove: (woId: string) =>
    api.delete<WorkOrderDeletionReport>(
      `/work-orders/${encodeURIComponent(woId)}`,
      undefined,
    ),
  /** The work order's own history — contract §8b. Same shape as the run journal. */
  journal: (woId: string, params: PageParams & { kind?: JournalKind } = {}) =>
    api.get<Paginated<JournalEntry>>(`/work-orders/${encodeURIComponent(woId)}/journal`, {
      ...params,
    }),
};
