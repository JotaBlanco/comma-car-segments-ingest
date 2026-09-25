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
import { SingleSelect } from "@/components/shared/single-select";
import { ApiError } from "@/lib/api/client";
import { useActor, useCreateRequirement } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import {
  RequirementFormFields,
  emptyRequirementFormValues,
  splitList,
  type RequirementFormValues,
} from "./requirement-form-fields";

/**
 * Add a requirement — manual only (authoring-controls §8). A planning row is
 * never created here; it arrives through `POST /planning/sync`.
 */

/* The only two statuses a requirement is born in — `RequirementCreateRequest`
   restricts the field to these, and every later move goes through the detail
   screen's status control (requirement-status-gates §4.1). */
const CREATE_STATUS_OPTIONS = ["NEW", "Draft"] as const;
type CreateStatus = (typeof CREATE_STATUS_OPTIONS)[number];

const FAILURES: Record<string, string> = {
  id_reuse: "That id is already used — retired ids are never reused. Pick a different id.",
  validation_error: "The registry refused a value. Check each field and save again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused it: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The requirement never reached the registry. Check the connection and try again.";
}

const stateDrivenPatterns = new Set(["StateDriven", "Complex"]);
const measuredMethods = new Set(["test", "tests"]);

interface AddRequirementDialogProps {
  readonly open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddRequirementDialog({ open, onOpenChange }: AddRequirementDialogProps) {
  const [id, setId] = useState("");
  const [values, setValues] = useState<RequirementFormValues>(emptyRequirementFormValues);
  const [status, setStatus] = useState<CreateStatus>("Draft");
  const [failure, setFailure] = useState<string | null>(null);

  const actor = useActor();
  const createRequirement = useCreateRequirement(actor);

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setId("");
      setValues(emptyRequirementFormValues());
      setStatus("Draft");
      setFailure(null);
    }
  };

  const submit = () => {
    if (actor === null) return;
    const trimmedId = id.trim();
    if (trimmedId.length === 0) {
      setFailure("A requirement needs an id.");
      return;
    }
    if (values.title.trim().length === 0 || values.text.trim().length === 0) {
      setFailure("A requirement needs a title and its EARS sentence.");
      return;
    }
    setFailure(null);

    createRequirement.mutate(
      {
        id: trimmedId,
        title: values.title.trim(),
        text: values.text.trim(),
        chapter: values.chapter.trim(),
        ears_pattern: values.ears_pattern,
        system_states: stateDrivenPatterns.has(values.ears_pattern)
          ? splitList(values.system_states)
          : undefined,
        rationale: values.rationale.trim() || undefined,
        source: splitList(values.source),
        verification_method: values.verification_method.trim(),
        measurand: measuredMethods.has(values.verification_method.trim().toLowerCase())
          ? values.measurand.filter((m) => m.name.trim().length > 0 && m.unit.trim().length > 0)
          : undefined,
        revision: values.revision.trim() || undefined,
        figure_refs: splitList(values.figure_refs),
        related_reqs: splitList(values.related_reqs),
        verification_criteria: values.verification_criteria.trim() || undefined,
        status,
      },
      {
        onSuccess: (created) => {
          toast(`${created.req_id} added — it carries the source manual`);
          close(false);
        },
        onError: (error) => setFailure(messageFor(error)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[10px] p-5 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            New requirement
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            Manual only. The row carries the source <b>manual</b> and starts at
            <b> NEW</b> or <b>Draft</b> — moving it further is the review flow.
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

        <div className="grid gap-1">
          <label htmlFor="req-id" className="text-[0.7rem] font-semibold text-ink-2">
            Id
          </label>
          <Input
            id="req-id"
            autoFocus
            value={id}
            placeholder="e.g. BAT-SYS-SAF-004"
            className="font-mono text-[0.8rem]"
            onChange={(event) => {
              setId(event.target.value);
              setFailure(null);
            }}
          />
        </div>

        <RequirementFormFields
          values={values}
          onChange={(next) => {
            setValues(next);
            setFailure(null);
          }}
        />

        <SingleSelect
          label="Status"
          value={status}
          onChange={(value) => setStatus(value === "NEW" ? "NEW" : "Draft")}
          options={CREATE_STATUS_OPTIONS.map((option) => ({ value: option, label: option }))}
        />

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
          <Button size="sm" disabled={actor === null || createRequirement.isPending} onClick={submit}>
            {createRequirement.isPending ? "Adding…" : "Add requirement"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
