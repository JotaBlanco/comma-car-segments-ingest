"use client";

import { useQuery } from "@tanstack/react-query";
import { workOrdersApi } from "@/lib/api/workOrders";
import type { JournalKind, PageParams, WorkOrderListFilters } from "@/types";
import { keys } from "./keys";

/** `enabled` false keeps a closed dialog silent — it sends no request at all. */
export function useWorkOrders(filters: WorkOrderListFilters = {}, enabled = true) {
  return useQuery({
    queryKey: keys.workOrders.list(filters),
    queryFn: () => workOrdersApi.list(filters),
    enabled,
  });
}

/* The project options of the work-orders screen. The screen used to hard-code
   its project list, so a newly mirrored project never reached the filter.
   This route reads the whole mirror in one call (contract §10b). */
export function useWorkOrderFacets() {
  return useQuery({ queryKey: keys.workOrders.facets, queryFn: () => workOrdersApi.facets() });
}

export function useWorkOrder(woId: string) {
  return useQuery({
    queryKey: keys.workOrders.detail(woId),
    queryFn: () => workOrdersApi.get(woId),
    enabled: woId.length > 0,
  });
}

/** The work order's own history — contract §8b. */
export function useWorkOrderJournal(
  woId: string,
  params: PageParams & { kind?: JournalKind } = {},
) {
  return useQuery({
    queryKey: keys.workOrders.journal(woId, params),
    queryFn: () => workOrdersApi.journal(woId, params),
    enabled: woId.length > 0,
  });
}
