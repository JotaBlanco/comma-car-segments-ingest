"use client";

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
import { useActor, useFileLifecycle, type FileLifecycleAction } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";

interface LifecycleDialogProps {
  fileId: string;
  filename: string;
  action: FileLifecycleAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The words each lifecycle write uses. One dialog, three directions.
 *
 * Every description states the real consequence of the route in
 * `api/api/routers/files.py`. The delete is a soft delete, so no sentence here
 * says "permanently" and no sentence says the registry drops a byte.
 */
const WORDS: Record<
  FileLifecycleAction,
  {
    title: (filename: string) => string;
    description: string;
    submit: string;
    pending: string;
    success: (filename: string) => string;
    danger: boolean;
  }
> = {
  archive: {
    title: (filename) => `Archive ${filename}`,
    description:
      "The file leaves the file table and keeps every byte. It still downloads. An edit and a new version both refuse until a person restores it. The status does not change.",
    submit: "Archive file",
    pending: "Archiving…",
    success: (filename) => `${filename} is archived — every byte stays, and it still downloads`,
    danger: false,
  },
  restore: {
    title: (filename) => `Restore ${filename}`,
    description:
      "The file returns to the file table and the download opens again. The restore writes the lifecycle and nothing else, so a quarantined file stays quarantined.",
    submit: "Restore file",
    pending: "Restoring…",
    success: (filename) => `${filename} is back in the file table — the status did not change`,
    danger: false,
  },
  delete: {
    title: (filename) => `Delete ${filename}`,
    description:
      "This is a soft delete. The registry keeps every byte and keeps the storage location. The file leaves the file table, and the download refuses until a person restores it. A restore brings the file back with the same status. Nothing removes the bytes later.",
    submit: "Delete file",
    pending: "Deleting…",
    success: (filename) => `${filename} is deleted — the bytes stay, and a restore brings it back`,
    danger: true,
  },
};

/** One sentence a person can act on, per refusal the three routes answer. */
const FAILURES: Record<string, string> = {
  file_not_found: "The registry holds no file under this id any more. Reload the screen.",
  file_deleted: "The file is deleted. Restore it first, then archive it.",
  validation_error: "The registry refused the note. Write one sentence and save again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused the change: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The change never reached the registry. Check the connection and try again.";
}

export function LifecycleDialog({
  fileId,
  filename,
  action,
  open,
  onOpenChange,
}: LifecycleDialogProps) {
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The journal names the person who made the change, so the change needs a
  // signed-in Quix Portal identity and never a typed default.
  const actor = useActor();
  const mutation = useFileLifecycle(fileId, action, actor);
  const words = WORDS[action];

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setNote("");
      setFailure(null);
    }
  };

  const submit = () => {
    if (actor === null) return;
    setFailure(null);
    const trimmed = note.trim();
    mutation.mutate(
      trimmed.length > 0 ? { note: trimmed } : {},
      {
        onSuccess: () => {
          toast(words.success(filename));
          close(false);
        },
        onError: (error) => setFailure(messageFor(error)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            {words.title(filename)}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            {words.description}
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
            aria-label="Note (optional)"
            placeholder="e.g. Superseded by the re-converted file from job ing-8841"
            className="min-h-[72px] bg-surface-2 text-[0.82rem] focus-visible:bg-surface"
            onChange={(event) => setNote(event.target.value)}
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
          <Button
            size="sm"
            disabled={actor === null || mutation.isPending}
            className={
              words.danger
                ? "border-red-fill bg-red-fill text-accent-ink hover:bg-red-fill-hover"
                : undefined
            }
            onClick={submit}
          >
            {mutation.isPending ? words.pending : words.submit}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
