"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/client";
import { useActor, useAddJournalNote, useAddRunNote } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import type { JournalEntityType } from "@/types";

/**
 * The shared "Add a note" dialog.
 *
 * It grew out of the run-note dialog when notes reached every entity. A run
 * note keeps its own route (`POST /test-runs/{run_id}/journal`), because the
 * run timeline unions context entries and the route existed first. Every other
 * entity posts through the generic `POST /journal` (`lib/api/journal.ts`).
 * One dialog serves both, so a note reads and behaves the same way everywhere.
 */
interface AddNoteDialogProps {
  entityType: JournalEntityType;
  entityId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * One sentence a person can act on, per refusal the two note routes answer.
 * The not-found code differs per entity (`api/api/routers/journal.py`), and
 * every one means the same thing here: the id went stale under the screen.
 */
const NOT_FOUND_CODES = [
  "run_not_found",
  "file_not_found",
  "signal_not_found",
  "wo_not_found",
  "result_not_found",
  "td_not_found",
] as const;

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if ((NOT_FOUND_CODES as readonly string[]).includes(error.code)) {
      return "The registry holds nothing under this id any more. Reload the screen.";
    }
    if (error.code === "validation_error") {
      return "The registry refused the note. Write one sentence and save again.";
    }
    return `The registry refused the note: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The note never reached the registry. Check the connection and try again.";
}

/**
 * The one Add-note control the entity history panels mount in their head.
 * One component, so the button reads the same way on every screen.
 */
export function AddNoteButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-[6px] rounded-md border border-border bg-surface-2 px-[11px] py-[5px] text-[0.74rem] font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Pencil className="size-[12px]" strokeWidth={2.2} />
      Add note
    </button>
  );
}

export function AddNoteDialog({ entityType, entityId, open, onOpenChange }: AddNoteDialogProps) {
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The journal names the person who wrote the note, so it needs a signed-in
  // Quix Portal identity and never a typed default.
  const actor = useActor();
  // Both hooks mount (the rules of hooks allow no branch); only one fires.
  // The run keeps its own route, which writes a real `note` entry.
  const runNote = useAddRunNote(entityId, actor);
  const entityNote = useAddJournalNote(entityType, entityId, actor);
  const addNote = entityType === "run" ? runNote : entityNote;

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setNote("");
      setFailure(null);
    }
  };

  const submit = () => {
    const trimmed = note.trim();
    if (trimmed.length === 0) {
      setFailure("A note needs some text.");
      return;
    }
    if (actor === null) return;
    setFailure(null);
    addNote.mutate(trimmed, {
      onSuccess: () => {
        toast(`Note added to ${entityId} — it sits in the journal under your name`);
        close(false);
      },
      onError: (error) => setFailure(messageFor(error)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Add a note to {entityId}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            A note joins the journal beside the automatic entries. It changes no field, and it
            carries the source <b>manual</b> and your name.
          </DialogDescription>
        </DialogHeader>

        {actor === null && (
          <div
            role="alert"
            className="rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2"
          >
            {NO_ACTOR_MESSAGE}
          </div>
        )}

        <div>
          <Textarea
            autoFocus
            value={note}
            aria-invalid={failure !== null || undefined}
            aria-label="Note text"
            placeholder="e.g. Rig operator reported a coolant top-up between cycle 8 and 9"
            className="min-h-[84px] bg-surface-2 text-[0.82rem] focus-visible:bg-surface"
            onChange={(event) => {
              setNote(event.target.value);
              if (event.target.value.trim().length > 0) setFailure(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {failure !== null && (
            <div role="alert" className="mt-1 text-[0.68rem] text-red">
              {failure}
            </div>
          )}
        </div>

        <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[0.74rem] text-ink-3">
          Journalled as{" "}
          <span className="font-mono text-[0.74rem] text-ink-2">
            {actor ?? "nobody — sign in first"}
          </span>
          , with the source <span className="font-mono text-[0.74rem] text-ink-2">manual</span>.
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={actor === null || addNote.isPending} onClick={submit}>
            {addNote.isPending ? "Saving…" : "Add note"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
