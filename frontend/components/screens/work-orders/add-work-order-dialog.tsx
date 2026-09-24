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
import { ApiError } from "@/lib/api/client";
import { useCreateWorkOrder } from "@/lib/hooks";

/**
 * Open a work order here — for a campaign the planning system never knew
 * about, which is the case a bench upload leaves with nowhere to land. A
 * planning campaign is never created here; it arrives through
 * `POST /planning/sync`.
 */

const FAILURES: Record<string, string> = {
  wo_exists: "A work order already carries that id. Open it instead, or pick another id.",
  validation_error: "The registry refused a value. Check each field and save again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused it: ${error.detail}`;
  }
  return "The work order never reached the registry. Check the connection and try again.";
}

interface AddWorkOrderDialogProps {
  readonly open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddWorkOrderDialog({ open, onOpenChange }: AddWorkOrderDialogProps) {
  const [woId, setWoId] = useState("");
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const createWorkOrder = useCreateWorkOrder();

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setWoId("");
      setTitle("");
      setProject("");
      setFailure(null);
    }
  };

  const submit = () => {
    const trimmedId = woId.trim();
    if (trimmedId.length === 0 || title.trim().length === 0) {
      setFailure("A work order needs an id and a title.");
      return;
    }
    setFailure(null);
    createWorkOrder.mutate(
      { wo_id: trimmedId, title: title.trim(), project: project.trim() },
      {
        onSuccess: (created) => {
          toast(`${created.wo_id} opened — it carries the source manual`);
          close(false);
        },
        onError: (error) => setFailure(messageFor(error)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            New work order
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            For a campaign the planning system does not know. The row carries the source{" "}
            <b>manual</b> and starts <b>active</b>. Use the id the traces declare, so the runs
            that claimed it find their campaign.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1">
          <label htmlFor="wo-id" className="text-[0.7rem] font-semibold text-ink-2">
            Id
          </label>
          <Input
            id="wo-id"
            autoFocus
            value={woId}
            placeholder="e.g. WO-BAT-2026-002"
            className="font-mono text-[0.8rem]"
            onChange={(event) => {
              setWoId(event.target.value);
              setFailure(null);
            }}
          />
        </div>

        <div className="grid gap-1">
          <label htmlFor="wo-title" className="text-[0.7rem] font-semibold text-ink-2">
            Title
          </label>
          <Input
            id="wo-title"
            value={title}
            placeholder="What the campaign is"
            className="text-[0.8rem]"
            onChange={(event) => {
              setTitle(event.target.value);
              setFailure(null);
            }}
          />
        </div>

        <div className="grid gap-1">
          <label htmlFor="wo-project" className="text-[0.7rem] font-semibold text-ink-2">
            Project <span className="font-normal text-ink-3">(optional)</span>
          </label>
          <Input
            id="wo-project"
            value={project}
            placeholder="e.g. BATTERY_DC_V1"
            className="font-mono text-[0.8rem]"
            onChange={(event) => {
              setProject(event.target.value);
              setFailure(null);
            }}
          />
        </div>

        {failure !== null && (
          <div
            role="alert"
            className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-red"
          >
            {failure}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={createWorkOrder.isPending} onClick={submit}>
            {createWorkOrder.isPending ? "Adding…" : "Add work order"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
