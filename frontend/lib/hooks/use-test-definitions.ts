"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { testDefinitionsApi } from "@/lib/api/testDefinitions";
import type {
  DefinitionCustomPropertiesBody,
  JournalKind,
  PageParams,
  RequirementsFileCreate,
  RequirementsFileEdit,
  TestDefinitionListFilters,
} from "@/types";
import { keys } from "./keys";

export function useTestDefinitions(filters: TestDefinitionListFilters = {}) {
  return useQuery({
    queryKey: keys.testDefinitions.list(filters),
    queryFn: () => testDefinitionsApi.list(filters),
  });
}

export function useTestDefinition(tdId: string) {
  return useQuery({
    queryKey: keys.testDefinitions.detail(tdId),
    queryFn: () => testDefinitionsApi.get(tdId),
    enabled: tdId.length > 0,
  });
}

/** The definition's own history — contract §8b. */
export function useTestDefinitionJournal(
  tdId: string,
  params: PageParams & { kind?: JournalKind } = {},
) {
  return useQuery({
    queryKey: keys.testDefinitions.journal(tdId, params),
    queryFn: () => testDefinitionsApi.journal(tdId, params),
    enabled: tdId.length > 0,
  });
}

/* The four write hooks below refresh the definition detail, because the
   document list lives on that read. The journal refreshes with it, so the
   history shows the write straight away. */

export function useAddRequirementsFile(tdId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RequirementsFileCreate) =>
      testDefinitionsApi.addRequirementsFile(tdId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.testDefinitions.detail(tdId) });
    },
  });
}

/** Add one binary requirements document. The API stores the bytes. */
export function useUploadRequirementsFileBytes(tdId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, name }: { file: File; name?: string }) =>
      testDefinitionsApi.uploadRequirementsFileBytes(tdId, file, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.testDefinitions.detail(tdId) });
    },
  });
}

/** Change the text of one manual TEXT document. The API journals what changed. */
export function useEditRequirementsFile(tdId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: RequirementsFileEdit }) =>
      testDefinitionsApi.editRequirementsFile(tdId, name, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.testDefinitions.detail(tdId) });
    },
  });
}

export function useRemoveRequirementsFile(tdId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => testDefinitionsApi.removeRequirementsFile(tdId, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.testDefinitions.detail(tdId) });
    },
  });
}

export function useSetDefinitionCustomProperties(tdId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DefinitionCustomPropertiesBody) =>
      testDefinitionsApi.setCustomProperties(tdId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.testDefinitions.detail(tdId) });
    },
  });
}
