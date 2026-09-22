"use client";

import { AddNoteDialog } from "@/components/shared/add-note-dialog";

interface RunNoteDialogProps {
  runId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The run's Add-a-note dialog.
 *
 * The dialog body moved to `components/shared/add-note-dialog.tsx` when notes
 * reached every entity, so one dialog serves them all. This wrapper stays
 * because the run detail names its dialogs by what they do, and because the
 * run posts through its own route (`POST /test-runs/{run_id}/journal`) — the
 * shared dialog picks that route from the entity type.
 */
export function RunNoteDialog({ runId, open, onOpenChange }: RunNoteDialogProps) {
  return (
    <AddNoteDialog entityType="run" entityId={runId} open={open} onOpenChange={onOpenChange} />
  );
}
