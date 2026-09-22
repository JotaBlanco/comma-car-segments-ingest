"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resultsApi, type ResultUploadMetadata } from "@/lib/api/results";
import type { JournalKind, PageParams, ResultListFilters, ResultPatchBody } from "@/types";
import { requireActor } from "./use-actor";
import { keys } from "./keys";

export function useResults(filters: ResultListFilters = {}) {
  return useQuery({ queryKey: keys.results.list(filters), queryFn: () => resultsApi.list(filters) });
}

/**
 * One result version, by its own id — `GET /results/{result_id}`.
 *
 * `enabled` keeps the call off the wire until a person opens the result, so a
 * tab nobody expanded asks the registry nothing.
 */
export function useResult(resultId: string | null) {
  return useQuery({
    queryKey: keys.results.detail(resultId ?? ""),
    queryFn: () => resultsApi.get(resultId as string),
    enabled: resultId !== null,
  });
}

/**
 * One result's history — `GET /results/{result_id}/journal` (TR-012).
 *
 * `enabled` keeps the call off the wire until a person opens the result
 * dialog, the same rule `useResult` follows: a row nobody expanded asks the
 * registry nothing.
 */
export function useResultJournal(
  resultId: string | null,
  params: PageParams & { kind?: JournalKind } = {},
) {
  return useQuery({
    queryKey: keys.results.journal(resultId ?? "", params),
    queryFn: () => resultsApi.journal(resultId as string, params),
    enabled: resultId !== null,
  });
}

/**
 * Edit one result — `PATCH /results/{result_id}`.
 *
 * The actor comes from the signed-in Quix Portal profile, so `requireActor`
 * refuses the write while no identity resolves. A 200 changes the row, the
 * stored version and the result journal, so the whole results branch and the
 * run detail branch both go stale.
 */
export function usePatchResult(resultId: string, runId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<ResultPatchBody, "actor">) =>
      resultsApi.patch(resultId, { ...body, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.results.all });
      void queryClient.invalidateQueries({ queryKey: keys.runs.detail(runId) });
    },
  });
}

export interface ResultUpload {
  file: File;
  metadata: ResultUploadMetadata;
}

/**
 * Upload one processed result to a run.
 *
 * A 201 adds a row and a journal entry, so the results list and the whole run
 * detail branch go stale together. The run detail key prefixes the run's
 * files, signals and journal keys, so one call refreshes all of them.
 */
export function useUploadResult(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, metadata }: ResultUpload) => resultsApi.upload(file, metadata),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.results.all });
      void queryClient.invalidateQueries({ queryKey: keys.runs.detail(runId) });
      void queryClient.invalidateQueries({ queryKey: keys.home });
    },
  });
}
