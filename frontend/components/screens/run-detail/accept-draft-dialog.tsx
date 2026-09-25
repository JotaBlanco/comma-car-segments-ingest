"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api/client";
import { acceptDraft, previewDraft, type Notebook } from "@/lib/api/run-quixlab";
import { keys } from "@/lib/hooks/keys";

/**
 * Accept a draft notebook's code as its definition's implementation.
 *
 * The dialog shows the exact module the API would store and sends back its digest, so
 * what a person accepts is what they read: a cell edited in the meantime answers 409
 * `draft_changed` and the preview reloads. Accepting stores the file only; nothing runs
 * and no verdict is written.
 */

const FAILURES: Record<string, string> = {
  draft_not_generated:
    "The draft cell has no generated code yet. Run it in QuixLab, then accept it.",
  not_a_draft: "This notebook drafts no definition, so there is nothing to accept.",
  notebook_not_found: "The notebook is gone.",
  notebook_file_not_found: "The notebook's file is not in storage any more.",
  storage_unreachable: "The notebook could not be read from storage. Try again.",
  draft_changed: "The code changed since you opened this. Review it again, then accept.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "draft_invalid") return `The code cannot be accepted: ${error.detail}`;
    return FAILURES[error.code] ?? `The Test Manager refused it: ${error.detail}`;
  }
  return "The call never reached the Test Manager.";
}

export function AcceptDraftDialog({
  runId,
  notebook,
  onOpenChange,
}: {
  runId: string;
  notebook: Notebook;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ["runs", "draft", runId, notebook.notebook_id],
    queryFn: () => previewDraft(runId, notebook.notebook_id),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const accept = useMutation({
    mutationFn: (sha256: string) => acceptDraft(runId, notebook.notebook_id, sha256),
    onSuccess: (stored) => {
      const td = preview.data?.definition_id ?? notebook.definition_id ?? "";
      toast(`${stored.filename} is now the implementation of ${td}.`);
      void queryClient.invalidateQueries({ queryKey: keys.testDefinitions.detail(td) });
      onOpenChange(false);
    },
    onError: (error) => {
      setFailure(messageFor(error));
      if (error instanceof ApiError && error.code === "draft_changed") void preview.refetch();
    },
  });

  const close = (next: boolean) => {
    if (accept.isPending) return;
    onOpenChange(next);
  };
  const draft = preview.data;

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Accept {notebook.name}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            {draft
              ? `This code becomes ${draft.filename}, the implementation of ${draft.definition_id}. ` +
                "The Run button evaluates with it from then on; accepting runs nothing."
              : "Reading the draft cell's code from the notebook…"}
          </DialogDescription>
        </DialogHeader>

        {preview.isError && (
          <p role="alert" className="text-[0.8rem] text-ink-2">
            {messageFor(preview.error)}
          </p>
        )}
        {draft && (
          <pre
            aria-label="Code to accept"
            className="max-h-[50vh] overflow-auto rounded-md border border-line-2 bg-surface-2 p-3 font-mono text-[0.74rem] text-ink"
          >
            {draft.code}
          </pre>
        )}
        {failure !== null && (
          <p role="alert" className="text-[0.8rem] text-red">
            {failure}
          </p>
        )}

        <DialogFooter>
          {draft && (
            <span className="mr-auto self-center font-mono text-[0.72rem] text-ink-3">
              sha256 {draft.sha256.slice(0, 12)}
            </span>
          )}
          <Button variant="outline" size="sm" disabled={accept.isPending} onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="font-semibold"
            disabled={!draft || accept.isPending || preview.isFetching}
            aria-busy={accept.isPending}
            onClick={() => {
              if (!draft) return;
              setFailure(null);
              accept.mutate(draft.sha256);
            }}
          >
            {accept.isPending ? "Accepting…" : "Accept"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
