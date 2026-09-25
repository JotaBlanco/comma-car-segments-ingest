"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CONFIRM_WORD, DESTRUCTIVE_CLASS } from "@/components/screens/runs/delete-runs-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/client";
import { formatInt } from "@/lib/format";
import { useDeleteWorkOrder } from "@/lib/hooks";

/**
 * Delete one work order and the test definitions under it.
 *
 * The registry refuses a work order any test run names (409
 * `work_order_has_runs`), and that refusal is the normal answer here rather
 * than an error state: a campaign that holds evidence is closed, not deleted.
 * Nothing on this side pre-empts it — the button is live whatever the screen
 * knows, the call goes, and the server's answer is what a person reads.
 */

function runsRefusal(runCount: number): string {
  const runs = runCount === 1 ? "1 test run" : `${formatInt(runCount)} test runs`;
  const names = runCount === 1 ? "names" : "name";
  return (
    `${runs} still ${names} this work order, so it stays. Close it instead — ` +
    "that marks the campaign inactive and leaves the runs where they are."
  );
}

const FAILURES: Record<string, string> = {
  wo_not_found: "The registry holds no work order under this id any more.",
};

function messageFor(error: unknown, runCount: number): string {
  if (error instanceof ApiError) {
    if (error.code === "work_order_has_runs") return runsRefusal(runCount);
    return FAILURES[error.code] ?? `The registry refused it: ${error.detail}`;
  }
  return "The call never reached the registry.";
}

interface DeleteWorkOrderDialogProps {
  readonly woId: string;
  /** The runs the detail read reported — the number the 409 talks about. */
  readonly runCount: number;
  readonly definitionCount: number;
  onOpenChange: (open: boolean) => void;
  /** Called once the work order is gone, so the screen can leave the page. */
  onDeleted: () => void;
}

export function DeleteWorkOrderDialog({
  woId,
  runCount,
  definitionCount,
  onOpenChange,
  onDeleted,
}: DeleteWorkOrderDialogProps) {
  const [typed, setTyped] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const deleteWorkOrder = useDeleteWorkOrder(woId);

  const armed = typed.trim().toLowerCase() === CONFIRM_WORD;

  const close = (next: boolean) => {
    if (deleteWorkOrder.isPending) return;
    if (!next) {
      setTyped("");
      setFailure(null);
    }
    onOpenChange(next);
  };

  const run = () => {
    if (!armed) return;
    setFailure(null);
    deleteWorkOrder.mutate(undefined, {
      onSuccess: (report) => {
        toast(
          `${report.wo_id} deleted, with ${formatInt(report.definitions)} ` +
            `${report.definitions === 1 ? "test definition" : "test definitions"}.`,
        );
        onDeleted();
      },
      onError: (error) => setFailure(messageFor(error, runCount)),
    });
  };

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Delete {woId}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            This cannot be undone. The work order goes, and so do the{" "}
            {formatInt(definitionCount)}{" "}
            {definitionCount === 1 ? "test definition" : "test definitions"} under it. The
            journal keeps every entry the work order ever had and gains a deletion entry.
          </DialogDescription>
        </DialogHeader>

        <div>
          <label htmlFor="wo-delete-confirm" className="text-[0.76rem] font-medium text-ink-2">
            Type <span className="font-mono font-semibold">{CONFIRM_WORD}</span> to confirm
          </label>
          <Input
            id="wo-delete-confirm"
            autoFocus
            autoComplete="off"
            value={typed}
            disabled={deleteWorkOrder.isPending}
            placeholder={CONFIRM_WORD}
            className="mt-1 bg-surface-2 text-[0.82rem] focus-visible:bg-surface"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        {failure !== null && (
          <div
            role="alert"
            className="rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2"
          >
            {failure}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={deleteWorkOrder.isPending}
            onClick={() => close(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className={DESTRUCTIVE_CLASS}
            disabled={!armed || deleteWorkOrder.isPending}
            onClick={run}
          >
            {deleteWorkOrder.isPending ? "Deleting…" : "Delete work order"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
