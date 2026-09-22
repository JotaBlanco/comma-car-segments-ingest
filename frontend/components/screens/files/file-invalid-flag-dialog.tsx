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
import { useActor, useClearFileInvalid, useFlagFileInvalid } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import { truncateFilename } from "./format";

/** Raise the mark, or take it back. Both writes need a reason. */
export type InvalidFlagMode = "raise" | "clear";

interface FileInvalidFlagDialogProps {
  fileId: string;
  filename: string;
  mode: InvalidFlagMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/* This dialog repeats `run-detail/invalid-flag-dialog.tsx` rather than reusing
   it. The run dialog binds to a run id, to `useFlagInvalid`/`useClearInvalid`,
   and to run wording and run refusal codes, so a shared component would need a
   prop rename across the run screen and its suite. Lane A owns the run screen
   and Lane B owns the file screens, and the two service files already repeat a
   helper for the same reason. The RULES are not repeated by hand: the reason
   is mandatory on both writes here too, and the server owns every check. */

/** The words each mode uses. One dialog, two directions. */
const WORDS = {
  raise: {
    title: (name: string) => `Mark ${name} as invalid`,
    description:
      "The file stays in the registry, it keeps every byte and it still downloads — it is never deleted. Its run is not marked. A reason is required and will be journalled with your name.",
    label: "Reason for flagging this file invalid",
    placeholder:
      "e.g. Cell 7 thermocouple came loose at 10:12 — the trace is noise from there on",
    submit: "Flag invalid",
    pending: "Flagging…",
    success: (name: string) => `${name} flagged invalid — journalled with reason`,
    /* The registry already holds the state the person asked for, so the
       dialog closes and says so. It never asks them to retry a done thing. */
    settled: "This file is already flagged invalid",
  },
  clear: {
    title: (name: string) => `Clear the invalid flag on ${name}`,
    description:
      "The file loses the mark. The mark and this reason both stay in the ingestion timeline, so the history keeps both steps.",
    label: "Reason for clearing the flag",
    placeholder: "e.g. Thermocouple re-seated and the trace re-read — the file is usable",
    submit: "Clear invalid flag",
    pending: "Clearing…",
    success: (name: string) => `${name} is valid again — journalled with reason`,
    settled: "This file carries no invalid flag",
  },
} as const;

/** One sentence a person can act on, per refusal the two routes answer. */
const FAILURES: Record<string, string> = {
  reason_required: "A reason is required.",
  file_not_found: "The registry holds no file under this id any more. Reload the screen.",
  validation_error: "The registry refused the reason. Write one sentence and save again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused the change: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The change never reached the registry. Check the connection and try again.";
}

export function FileInvalidFlagDialog({
  fileId,
  filename,
  mode,
  open,
  onOpenChange,
}: FileInvalidFlagDialogProps) {
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The journal names the person who made the change, so the change needs a
  // signed-in Quix Portal identity and never a typed default.
  const actor = useActor();
  const flagInvalid = useFlagFileInvalid(fileId, actor);
  const clearInvalid = useClearFileInvalid(fileId, actor);
  const mutation = mode === "raise" ? flagInvalid : clearInvalid;
  const words = WORDS[mode];
  const name = truncateFilename(filename);

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setReason("");
      setFailure(null);
    }
  };

  const submit = () => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setFailure("A reason is required.");
      return;
    }
    if (actor === null) return;
    setFailure(null);
    mutation.mutate(trimmed, {
      onSuccess: () => {
        toast(words.success(name));
        close(false);
      },
      onError: (error) => {
        // A 409 says the registry already holds the state the person asked
        // for. The hook refetches the file, so the screen catches up by itself.
        if (error instanceof ApiError && error.status === 409) {
          toast(words.settled);
          close(false);
          return;
        }
        setFailure(messageFor(error));
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            {words.title(name)}
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
            value={reason}
            aria-invalid={failure !== null || undefined}
            aria-label={words.label}
            placeholder={words.placeholder}
            className="min-h-[84px] bg-surface-2 text-[0.82rem] focus-visible:bg-surface"
            onChange={(event) => {
              setReason(event.target.value);
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
          <Button
            size="sm"
            disabled={actor === null || mutation.isPending}
            className={
              mode === "raise"
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
