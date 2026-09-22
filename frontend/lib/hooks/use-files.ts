"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { filesApi } from "@/lib/api/files";
import type { FileListFilters, FileVersionRegisterBody, JournalKind, PageParams } from "@/types";
import { keys } from "./keys";
import { requireActor } from "./use-actor";

export function useFiles(
  filters: FileListFilters = {},
  opts: { poll?: boolean; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: keys.files.list(filters),
    queryFn: () => filesApi.list(filters),
    enabled: opts.enabled ?? true,
    // The watcher polls every 30 s. The files screen asks to poll here too
    // (runbook Act 1: "Navigate to Files while they land"), so the six files
    // appear while the presenter stands still. Opt-in, never hook-wide: the
    // ⌘K palette reads this hook as well, and it must not poll for ever.
    refetchInterval: opts.poll === true ? 10_000 : false,
  });
}

/**
 * The detail response embeds the signals. The server default of 200 cut a
 * 261-signal file short. Ask for 500 — the top of the API's allow-list
 * (10…500) and above the real band's 261 — so the client holds the whole
 * file and pages it locally. A file beyond 500 still truncates, and the
 * signals table footer says so.
 */
const FILE_SIGNALS_LIMIT = 500;

export function useFile(fileId: string) {
  return useQuery({
    queryKey: keys.files.detail(fileId),
    queryFn: () => filesApi.get(fileId, FILE_SIGNALS_LIMIT),
    enabled: fileId.length > 0,
  });
}

/** The file's own history — contract §8b. */
export function useFileJournal(fileId: string, params: PageParams & { kind?: JournalKind } = {}) {
  return useQuery({
    queryKey: keys.files.journal(fileId, params),
    queryFn: () => filesApi.journal(fileId, params),
    enabled: fileId.length > 0,
  });
}
/** The whole version chain of one file — `GET /files/{id}/versions`. */
export function useFileVersions(fileId: string) {
  return useQuery({
    queryKey: keys.files.versions(fileId),
    queryFn: () => filesApi.versions(fileId),
    enabled: fileId.length > 0,
  });
}

/** The three lifecycle writes a person can make on one file. */
export type FileLifecycleAction = "archive" | "restore" | "delete";

/** The optional note each lifecycle write carries into the journal. */
export interface FileLifecycleInput {
  note?: string;
}

/**
 * Archive, restore or soft-delete one file.
 *
 * The delete keeps every byte and keeps `storage_ref`, so a restore brings the
 * file back. The journal names the signed-in person, so the mutation refuses
 * without a Portal identity.
 */
export function useFileLifecycle(
  fileId: string,
  action: FileLifecycleAction,
  actor: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ note }: FileLifecycleInput = {}) => {
      const body = { actor: requireActor(actor), ...(note ? { note } : {}) };
      if (action === "archive") return filesApi.archive(fileId, body);
      if (action === "restore") return filesApi.restore(fileId, body);
      return filesApi.remove(fileId, body);
    },
    onSuccess: () => {
      // The row leaves or rejoins the table, and the run rollups read it, so
      // the file list, the file detail and the run views all go stale.
      void queryClient.invalidateQueries({ queryKey: keys.files.all });
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
      void queryClient.invalidateQueries({ queryKey: keys.home });
    },
  });
}

/**
 * Register a new version of one file — `POST /files/{id}/versions`.
 *
 * The new version is a whole file document with its own id and its own
 * checksum, so no earlier version changes.
 */
export function useRegisterFileVersion(fileId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<FileVersionRegisterBody, "actor">) =>
      filesApi.registerVersion(fileId, { ...body, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.files.all });
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
    },
  });
}

/**
 * Mark one file invalid — `POST /files/{id}/invalid-flag`.
 *
 * It copies `useFlagInvalid` of the run lane. The journal names the person who
 * made the judgment, so the mutation refuses without a Portal identity.
 *
 * The run views go stale as well, because a run screen lists its files and the
 * mark shows on those rows. The run RECORD never changes — the route touches
 * the file alone — so this refetches a view and never repairs a write.
 */
export function useFlagFileInvalid(fileId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      filesApi.flagInvalid(fileId, { reason, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.files.all });
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
    },
    onError: (error) => {
      // 409 already_flagged says our cached file is stale — refresh it.
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: keys.files.all });
      }
    },
  });
}

/**
 * Take the mark back — `DELETE /files/{id}/invalid-flag`.
 *
 * The reason stays mandatory, so a rehearsal that marks a file states why it
 * clears the mark. Without this hook a mark raised on stage stands for ever.
 */
export function useClearFileInvalid(fileId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      filesApi.clearInvalid(fileId, { reason, actor: requireActor(actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.files.all });
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
    },
    onError: (error) => {
      // 409 not_flagged says our cached file is stale — refresh it.
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: keys.files.all });
      }
    },
  });
}
