"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { planningSyncApi } from "@/lib/api/planningSync";
import { keys } from "./keys";

export function usePlanningSyncStatus() {
  // Polled: the topbar's demo controls disable while status is unknown, and
  // without a poll one failed load (an API cold start, a blip) left them
  // disabled FOREVER — react-query gives up after its retries and nothing
  // ever asks again (25 Aug 2026). The poll also keeps the switch honest
  // when another tab toggles it.
  return useQuery({
    queryKey: keys.planningSync,
    queryFn: planningSyncApi.status,
    refetchInterval: 15_000,
  });
}

export function useToggleSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (online: boolean) => planningSyncApi.toggle(online),
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
}

/**
 * Run one sync pass without touching the switch —
 * `POST /planning-sync/trigger`.
 *
 * A pass can mirror work orders, backfill waiting runs and end their
 * `awaiting_work_order` state, so every cached read can be stale after it.
 * The blanket invalidation is the same call the toggle makes, and for the
 * same reason.
 */
export function useTriggerSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => planningSyncApi.trigger(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
}
