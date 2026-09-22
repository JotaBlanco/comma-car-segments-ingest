"use client";

import { KeyRound } from "lucide-react";
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
import { useActor, useRequestAccess } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import type { JournalEntityType } from "@/types";

/**
 * The "Request access" dialog — UC-003 step 4, contract §D-Access.
 *
 * **Read this before you change a word of the text below.** The Test Manager
 * has no scoped access at all. The only check is workspace `Read` through the
 * Quix Portal, and no role, no project and no classification exists in the
 * code. So this screen cannot grant anything, and nothing it says may imply
 * that it can. It records the ask in the journal, under the signed-in name,
 * and a person acts on it outside this system.
 *
 * That honesty is the whole feature. A cheerful "Access granted" would be a
 * lie, and a "Pending approval" would name an approval flow nobody built.
 */
interface RequestAccessDialogProps {
  entityType: JournalEntityType;
  entityId: string;
  /** What the person is looking at, in their words. It goes in the title. */
  entityLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
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
      return "The registry refused the request. Write one sentence about why you need this, then send again.";
    }
    return `The registry refused the request: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The request never reached the registry. Check the connection and try again.";
}

/** The control that opens the dialog. One component, so it reads the same everywhere. */
export function RequestAccessButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Record a request for access. The Test Manager grants nothing — a person acts on it."
      className="inline-flex items-center gap-[7px] rounded-md border border-border bg-surface-2 px-[13px] py-[7px] text-[0.78rem] font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <KeyRound className="size-[13px]" strokeWidth={2.2} />
      Request access
    </button>
  );
}

export function RequestAccessDialog({
  entityType,
  entityId,
  entityLabel,
  open,
  onOpenChange,
}: RequestAccessDialogProps) {
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The journal names the person who asked, so the control needs a signed-in
  // Quix Portal identity and never a typed default.
  const actor = useActor();
  const requestAccess = useRequestAccess(entityType, entityId, actor);

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
      setFailure("Say why you need this. A reviewer can act on nothing else.");
      return;
    }
    if (actor === null) return;
    setFailure(null);
    requestAccess.mutate(trimmed, {
      onSuccess: () => {
        toast(
          `Request recorded on ${entityId}. It grants nothing — a person reads the journal and acts on it.`,
        );
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
            Request access to {entityLabel}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            The Test Manager cannot grant access, and sending this changes nothing you can
            reach. It records your request in the journal, under your name, and a person reads
            it and acts outside this system.
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
            aria-label="Why you need this"
            placeholder="e.g. I need the raw MF4 for the cell-temperature investigation on WO-2026-0847"
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
          <Button size="sm" disabled={actor === null || requestAccess.isPending} onClick={submit}>
            {requestAccess.isPending ? "Recording…" : "Record request"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
