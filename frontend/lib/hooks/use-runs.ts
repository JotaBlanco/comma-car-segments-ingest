"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { runsApi } from "@/lib/api/runs";
import type {
  JournalKind,
  PageParams,
  RunGroupFilters,
  RunListFilters,
  RunPatchBody,
} from "@/types";
import { requireActor } from "./use-actor";
import { keys } from "./keys";

export function useRuns(
  filters: RunListFilters = {},
  opts: { enabled?: boolean; poll?: boolean } = {},
) {
  return useQuery({
    queryKey: keys.runs.list(filters),
    queryFn: () => runsApi.list(filters),
    enabled: opts.enabled ?? true,
    // The watcher polls every 30 s. Poll here too, so a new run appears
    // while the presenter stands still. Polling stays the default — the runs
    // screen is the main caller — but the ⌘K palette opts out: a closed
    // palette must not refetch the top-ten list for ever.
    refetchInterval: (opts.poll ?? true) ? 10_000 : false,
  });
}

/* Contract §2c — the grouped counts for the runs screen's Group-by control.
   It takes the SAME filters object the list takes, so the two answers can
   never describe different rows. It polls like the list does, so a new run
   moves its group while the presenter stands still. */
export function useRunGroups(
  filters: RunGroupFilters,
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: keys.runs.groups(filters),
    queryFn: () => runsApi.groups(filters),
    enabled: opts.enabled ?? true,
    refetchInterval: 10_000,
  });
}

/* The filter options of the runs screen. The list route serves one page and
   the screen used to derive its rig options from the newest 200 runs, so an
   idle rig dropped out of the filter. This route answers over the whole
   table in one call (contract §2b). */
export function useRunFacets() {
  return useQuery({
    queryKey: keys.runs.facets,
    queryFn: () => runsApi.facets(),
  });
}

/* The run detail polls like the list does. The planning mock pushes in the
   background — Act 2's backfill claims a run into its work order while the
   run's page is open — and files keep landing on a fresh run. Without the
   poll the page freezes on its first answer and the presenter reloads by
   hand to see the claim. */

export function useRun(runId: string) {
  return useQuery({
    queryKey: keys.runs.detail(runId),
    queryFn: () => runsApi.get(runId),
    enabled: runId.length > 0,
    refetchInterval: 10_000,
  });
}

export function useRunFiles(runId: string, params: PageParams = {}) {
  return useQuery({
    queryKey: keys.runs.files(runId, params),
    queryFn: () => runsApi.files(runId, params),
    refetchInterval: 10_000,
    // The page a person is on stays on screen while the next one loads, so a
    // ten-second refetch never blanks the table under them.
    placeholderData: (previous) => previous,
  });
}

export function useRunSignals(runId: string, params: PageParams = {}) {
  return useQuery({
    queryKey: keys.runs.signals(runId, params),
    queryFn: () => runsApi.signals(runId, params),
    refetchInterval: 10_000,
  });
}

export function useRunJournal(
  runId: string,
  params: PageParams & { kind?: JournalKind } = {},
) {
  return useQuery({
    queryKey: keys.runs.journal(runId, params),
    queryFn: () => runsApi.journal(runId, params),
  });
}

export function useRunLineage(runId: string) {
  return useQuery({
    queryKey: keys.runs.lineage(runId),
    queryFn: () => runsApi.lineage(runId),
  });
}

/* Every write hook below takes the actor as an argument. The caller reads it
   from `useActor`, so the name always comes from the signed-in Quix Portal
   profile. No hook holds a default, so no write can carry a literal name. */

export function usePatchRun(runId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<RunPatchBody, "actor">) =>
      runsApi.patch(runId, { ...body, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
      void queryClient.invalidateQueries({ queryKey: keys.home });
      // A patch can link or unlink the run's work order and definition, and
      // both of those screens count their runs (actual vs planned). Leave the
      // counts cached and they state the world before the link.
      void queryClient.invalidateQueries({ queryKey: keys.workOrders.all });
      void queryClient.invalidateQueries({
        queryKey: keys.testDefinitions.all,
      });
    },
  });
}

export function useFlagInvalid(runId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      runsApi.flagInvalid(runId, { reason, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
      void queryClient.invalidateQueries({ queryKey: keys.signals.all });
      void queryClient.invalidateQueries({ queryKey: keys.home });
    },
    onError: (error) => {
      // 409 already_flagged means our cached run state is stale — refresh it.
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === "already_flagged"
      ) {
        void queryClient.invalidateQueries({ queryKey: keys.runs.all });
      }
    },
  });
}

/**
 * Clear an invalid flag — `DELETE /test-runs/{run_id}/invalid-flag`.
 *
 * The route keeps the reason mandatory, so a rehearsal that flags a run states
 * why it takes the flag back. Without this hook a flag raised on stage stands
 * for ever.
 */
export function useClearInvalid(runId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      runsApi.clearInvalid(runId, { reason, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
      void queryClient.invalidateQueries({ queryKey: keys.signals.all });
      void queryClient.invalidateQueries({ queryKey: keys.home });
    },
    onError: (error) => {
      // 409 not_flagged means our cached run state is stale — refresh it.
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: keys.runs.all });
      }
    },
  });
}

/** Add a free-text note — `POST /test-runs/{run_id}/journal`. */
export function useAddRunNote(runId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (note: string) =>
      runsApi.addNote(runId, { note, actor: requireActor(actor) }),
    onSuccess: () => {
      // The note lands in the timeline and bumps the run's journal count.
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
    },
  });
}
