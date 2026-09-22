"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signalsApi } from "@/lib/api/signals";
import type {
  JournalKind,
  PageParams,
  SignalListFilters,
  SignalPatchBody,
  SignalStatsFilters,
} from "@/types";
import { requireActor } from "./use-actor";
import { keys } from "./keys";

export function useSignals(filters: SignalListFilters = {}, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: keys.signals.list(filters),
    queryFn: () => signalsApi.list(filters),
    enabled: opts.enabled ?? true,
  });
}

/* The filter options of the signals screen. The catalog holds 6,412 rows and
   the largest page is 500, so a list built from a page misses 92 per cent of
   the values. This route answers over the whole catalog in one call. */
export function useSignalFacets() {
  return useQuery({ queryKey: keys.signals.facets, queryFn: () => signalsApi.facets() });
}

export function useSignal(name: string) {
  return useQuery({
    queryKey: keys.signals.detail(name),
    queryFn: () => signalsApi.get(name),
    enabled: name.length > 0,
  });
}

export function useSignalRunStats(name: string, filters: SignalStatsFilters = {}) {
  return useQuery({
    queryKey: keys.signals.runStats(name, filters),
    queryFn: () => signalsApi.runStats(name, filters),
    enabled: name.length > 0,
  });
}

/* The actor comes from the caller, which reads it from `useActor`. The hook
   holds no default name. See the note in `use-runs.ts`. */
export function usePatchSignal(name: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<SignalPatchBody, "actor">) =>
      signalsApi.patch(name, { ...body, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.signals.all });
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
    },
  });
}

/** The signal's own history — contract §8b. */
export function useSignalJournal(name: string, params: PageParams & { kind?: JournalKind } = {}) {
  return useQuery({
    queryKey: keys.signals.journal(name, params),
    queryFn: () => signalsApi.journal(name, params),
    enabled: name.length > 0,
  });
}
