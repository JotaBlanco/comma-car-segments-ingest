"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workOrdersApi } from "@/lib/api/workOrders";
import type {
  JournalKind,
  PageParams,
  WorkOrderCreateBody,
  WorkOrderListFilters,
  WorkOrderStatus,
} from "@/types";
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

/**
 * Open a campaign the planning system never knew about.
 *
 * A new row changes the list, its view counts and the project facets, and
 * Home counts work orders. The creation is journalled, so the audit and the
 * bell refresh with it.
 */
export function useCreateWorkOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: WorkOrderCreateBody) => workOrdersApi.create(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.workOrders.all });
      void queryClient.invalidateQueries({ queryKey: keys.journal.all });
      void queryClient.invalidateQueries({ queryKey: keys.home });
    },
  });
}

/**
 * Close a campaign or reopen it.
 *
 * `workOrders.all` covers the list, its view counts, the detail and the
 * work-order journal panel, which hangs under the detail key. The status move
 * is journalled, so the cross-entity audit and the bell refresh too.
 */
export function useSetWorkOrderStatus(woId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (status: WorkOrderStatus) => workOrdersApi.setStatus(woId, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.workOrders.all });
      void queryClient.invalidateQueries({ queryKey: keys.journal.all });
    },
  });
}

/**
 * Delete a work order and the test definitions under it.
 *
 * The definitions go with it, so their list and facets are stale too, and
 * Home counts both. A work order holding runs is refused, so no run list
 * moves.
 */
export function useDeleteWorkOrder(woId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => workOrdersApi.remove(woId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.workOrders.all });
      void queryClient.invalidateQueries({ queryKey: keys.testDefinitions.all });
      void queryClient.invalidateQueries({ queryKey: keys.journal.all });
      void queryClient.invalidateQueries({ queryKey: keys.home });
    },
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
