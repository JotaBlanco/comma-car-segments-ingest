"use client";

/**
 * The hand-repair writes: the manual file-to-run link (TR-003) and the
 * generic journal note. Both state a fact the pipeline could not, and both
 * journal the signed-in person.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { filesApi, type FilePatchBody } from "@/lib/api/files";
import { journalApi } from "@/lib/api/journal";
import type { JournalEntityType } from "@/types";
import { keys } from "./keys";
import { requireActor } from "./use-actor";

/**
 * Edit one file by hand — `PATCH /files/{file_id}`.
 *
 * The main caller is the quarantine repair (TR-003): a file quarantined for
 * "no run key" leaves quarantine when a person states the run link, because
 * the missing link was the reason it was refused. The same route carries a
 * later stage outcome, so the input keeps the whole patchable set.
 *
 * The journal names the signed-in person, so the mutation refuses without a
 * Portal identity — the same rule every other write hook follows.
 */
export function usePatchFile(fileId: string, actor: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<FilePatchBody, "actor">) =>
      filesApi.patch(fileId, { ...body, actor: requireActor(actor) }),
    onSuccess: () => {
      // A repaired link moves the file between quick views, joins it to a
      // run's rollups and can end a quarantine, so the file views, the run
      // views and the home counts all go stale together.
      void queryClient.invalidateQueries({ queryKey: keys.files.all });
      void queryClient.invalidateQueries({ queryKey: keys.runs.all });
      void queryClient.invalidateQueries({ queryKey: keys.home });
    },
  });
}

/**
 * The query key a fresh note makes stale, per entity type. Each journal key
 * nests under its entity's detail key (`lib/hooks/keys.ts`), so invalidating
 * the detail prefix refreshes the timeline and the counts in one call. The
 * run is broader on purpose: its journal count sits on the list rows too.
 */
const NOTE_STALE_KEYS: Record<JournalEntityType, (id: string) => readonly unknown[]> = {
  run: () => keys.runs.all,
  file: (id) => keys.files.detail(id),
  signal: (id) => keys.signals.detail(id),
  work_order: (id) => keys.workOrders.detail(id),
  result: (id) => keys.results.detail(id),
  test_definition: (id) => keys.testDefinitions.detail(id),
  // An export names a list, not a document, so it owns no detail screen and
  // no nested journal. The Audit table is the only place its rows appear.
  export: () => keys.journal.all,
};

/**
 * Add a person's note to any entity — `POST /journal`.
 *
 * The run's own note route stays first choice for a run
 * (`useAddRunNote`): it writes a real `note` entry, while the generic route
 * takes events only. The shared Add-note dialog picks between the two.
 */
export function useAddJournalNote(
  entityType: JournalEntityType,
  entityId: string,
  actor: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (note: string) =>
      journalApi.addNote({
        entity_type: entityType,
        entity_id: entityId,
        note,
        actor: requireActor(actor),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: NOTE_STALE_KEYS[entityType](entityId),
      });
    },
  });
}

/**
 * Record a request for access to one entity — `POST /access-requests`.
 *
 * **This grants nothing and it must never claim to.** The registry holds no
 * scoped access, so it writes the ask into the journal and a person acts on
 * it outside the system (contract §D-Access, UC-003 step 4).
 *
 * The entry lands on the entity's timeline, so the same keys a note makes
 * stale go stale here.
 */
export function useRequestAccess(
  entityType: JournalEntityType,
  entityId: string,
  actor: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      journalApi.requestAccess({
        entity_type: entityType,
        entity_id: entityId,
        reason,
        actor: requireActor(actor),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: NOTE_STALE_KEYS[entityType](entityId),
      });
    },
  });
}
