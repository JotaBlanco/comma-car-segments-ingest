"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requirementsApi } from "@/lib/api/requirements";
import type {
  JournalKind,
  PageParams,
  RequirementCreateBody,
  RequirementListFilters,
  RequirementPatchBody,
  RequirementRetireBody,
} from "@/types";
import { keys } from "./keys";
import { requireActor } from "./use-actor";

export function useRequirements(filters: RequirementListFilters = {}) {
  return useQuery({
    queryKey: keys.requirements.list(filters),
    queryFn: () => requirementsApi.list(filters),
  });
}

/* The filter options of the requirements screen. The list route serves one
   filtered page, and a customer's chapter/status/method strings must come
   from the whole mirror or a selection could never add a second value —
   the same bug `runs-screen.tsx:60-70` records for rigs and projects. */
export function useRequirementFacets() {
  return useQuery({
    queryKey: keys.requirements.facets,
    queryFn: () => requirementsApi.facets(),
  });
}

export function useRequirement(reqId: string) {
  return useQuery({
    queryKey: keys.requirements.detail(reqId),
    queryFn: () => requirementsApi.get(reqId),
    enabled: reqId.length > 0,
  });
}

/** The requirement's own history — contract §8b. */
export function useRequirementJournal(
  reqId: string,
  params: PageParams & { kind?: JournalKind } = {},
) {
  return useQuery({
    queryKey: keys.requirements.journal(reqId, params),
    queryFn: () => requirementsApi.journal(reqId, params),
    enabled: reqId.length > 0,
  });
}

/* The three write hooks below take the actor as an argument, read from
   `useActor`, so the name always comes from the signed-in Quix Portal
   profile — the same rule every other write hook in this app follows. */

export function useCreateRequirement(actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<RequirementCreateBody, "actor">) =>
      requirementsApi.create({ ...body, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.requirements.all });
      void queryClient.invalidateQueries({ queryKey: keys.home });
    },
  });
}

export function usePatchRequirement(reqId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<RequirementPatchBody, "actor">) =>
      requirementsApi.patch(reqId, { ...body, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.requirements.all });
    },
  });
}

export function useRetireRequirement(reqId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<RequirementRetireBody, "actor">) =>
      requirementsApi.retire(reqId, { ...body, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.requirements.all });
      void queryClient.invalidateQueries({ queryKey: keys.home });
    },
  });
}
