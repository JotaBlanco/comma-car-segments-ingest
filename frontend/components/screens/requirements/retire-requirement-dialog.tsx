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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/client";
import { requirementsApi } from "@/lib/api/requirements";
import { DESTRUCTIVE_CLASS } from "@/components/screens/runs/delete-runs-dialog";
import { keys, useActor } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Retire, never delete (authoring-controls §5). `status` moves to `Obsolete`,
 * the row and its id stay, and a successor can be named. Shaped on
 * `delete-runs-dialog.tsx`'s typed-word confirm — the one destructive-control
 * idiom this app has — with the word changed to match the verb, since retire
 * is not delete and must not read as one.
 */

export const RETIRE_CONFIRM_WORD = "retire";

/**
 * One row this dialog can retire. `item_version` is optional: the detail
 * screen already holds a freshly-loaded one and passes it, but the list and
 * the batch bar do not — `RequirementRow` carries no `item_version`
 * (architecture doc, "Beyond §10"). When absent, the dialog fetches the
 * row's current version immediately before retiring it, which is also the
 * more correct guard: a version cached at list-load time could already be
 * stale by the time a person confirms.
 */
export interface RetirableRequirement {
  readonly req_id: string;
  readonly item_version?: number;
}

interface Failure {
  readonly reqId: string;
  readonly message: string;
}

const FAILURES: Record<string, string> = {
  stale_parent:
    "This requirement changed since the list loaded. Reload and retire again.",
  already_obsolete: "This requirement is already retired.",
  requirement_not_found: "The registry holds no requirement under this id any more.",
  validation_error: "The registry refused the retirement. Check the successor id and try again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused it: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The call never reached the registry.";
}

interface RetireRequirementDialogProps {
  readonly open: boolean;
  onOpenChange: (open: boolean) => void;
  readonly rows: readonly RetirableRequirement[];
  onDone?: (failedIds: readonly string[]) => void;
}

export function RetireRequirementDialog({
  open,
  onOpenChange,
  rows,
  onDone,
}: RetireRequirementDialogProps) {
  const [typed, setTyped] = useState("");
  const [successorId, setSuccessorId] = useState("");
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<number | null>(null);
  const [failures, setFailures] = useState<readonly Failure[] | null>(null);

  const actor = useActor();
  const queryClient = useQueryClient();
  const count = rows.length;
  const running = sent !== null;
  const armed = typed.trim().toLowerCase() === RETIRE_CONFIRM_WORD;

  const close = (next: boolean) => {
    if (running) return;
    if (!next) {
      setTyped("");
      setSuccessorId("");
      setNote("");
      setFailures(null);
    }
    onOpenChange(next);
  };

  const run = async () => {
    if (!armed || actor === null || count === 0) return;
    setSent(0);
    setFailures(null);
    const failed: Failure[] = [];
    const trimmedSuccessor = successorId.trim();
    const trimmedNote = note.trim();

    for (const row of rows) {
      try {
        const parentVersion =
          row.item_version ?? (await requirementsApi.get(row.req_id)).item_version;
        await requirementsApi.retire(row.req_id, {
          parent_version: parentVersion,
          actor,
          ...(trimmedSuccessor.length > 0 ? { successor_id: trimmedSuccessor } : {}),
          ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
        });
      } catch (error) {
        failed.push({ reqId: row.req_id, message: messageFor(error) });
      }
      setSent((done) => (done ?? 0) + 1);
    }

    setSent(null);
    void queryClient.invalidateQueries({ queryKey: keys.requirements.all });
    void queryClient.invalidateQueries({ queryKey: keys.home });

    if (failed.length === 0) {
      toast(`${count} ${count === 1 ? "requirement" : "requirements"} retired.`);
      setTyped("");
      onDone?.([]);
      onOpenChange(false);
      return;
    }
    setFailures(failed);
    onDone?.(failed.map((entry) => entry.reqId));
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Retire {count} {count === 1 ? "requirement" : "requirements"}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            Retiring is not deleting. The row and its id stay — a retired id is never reused —
            and its status moves to <b>Obsolete</b>. It drops out of the coverage count but stays
            reachable by id for the audit trail.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[120px] overflow-y-auto rounded-md border border-line bg-surface-2 px-3 py-2">
          <ul className="space-y-0.5">
            {rows.map((row) => (
              <li key={row.req_id} className="font-mono text-[0.74rem] text-ink-2">
                {row.req_id}
              </li>
            ))}
          </ul>
        </div>

        {actor === null && (
          <div
            role="alert"
            className="rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2"
          >
            {NO_ACTOR_MESSAGE}
          </div>
        )}

        {failures === null && (
          <>
            <div className="grid gap-1">
              <label htmlFor="retire-successor" className="text-[0.76rem] font-medium text-ink-2">
                Successor id <span className="font-normal text-ink-3">(optional)</span>
              </label>
              <Input
                id="retire-successor"
                autoComplete="off"
                value={successorId}
                disabled={running}
                placeholder="e.g. BAT-SYS-SAF-004"
                className="bg-surface-2 text-[0.82rem] focus-visible:bg-surface"
                onChange={(event) => setSuccessorId(event.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <label htmlFor="retire-note" className="text-[0.76rem] font-medium text-ink-2">
                Note <span className="font-normal text-ink-3">(optional)</span>
              </label>
              <Textarea
                id="retire-note"
                value={note}
                disabled={running}
                placeholder="Why this requirement is retired"
                className="min-h-[56px] bg-surface-2 text-[0.8rem] focus-visible:bg-surface"
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="retire-confirm" className="text-[0.76rem] font-medium text-ink-2">
                Type <span className="font-mono font-semibold">{RETIRE_CONFIRM_WORD}</span> to
                confirm
              </label>
              <Input
                id="retire-confirm"
                autoFocus
                autoComplete="off"
                value={typed}
                disabled={running}
                placeholder={RETIRE_CONFIRM_WORD}
                className="mt-1 bg-surface-2 text-[0.82rem] focus-visible:bg-surface"
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            <div role="status" className="text-[0.76rem] text-ink-2">
              {running ? `Working — ${sent ?? 0} of ${count} retired.` : ""}
            </div>
          </>
        )}

        {failures !== null && failures.length > 0 && (
          <div
            role="alert"
            className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-ink-2"
          >
            <p className="font-semibold">
              {count - failures.length} of {count} retired.
            </p>
            <ul className="mt-1.5 space-y-1">
              {failures.map((entry) => (
                <li key={entry.reqId}>
                  <span className="font-mono text-[0.74rem]">{entry.reqId}</span> —{" "}
                  {entry.message}
                </li>
              ))}
              <li className="pt-0.5">The failed rows stay picked, so you can try again.</li>
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={running} onClick={() => close(false)}>
            {failures === null ? "Cancel" : "Done"}
          </Button>
          {failures === null && (
            <Button
              size="sm"
              className={DESTRUCTIVE_CLASS}
              disabled={!armed || actor === null || running}
              onClick={() => void run()}
            >
              {running ? "Retiring…" : `Retire ${count === 1 ? "requirement" : `${count} requirements`}`}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
