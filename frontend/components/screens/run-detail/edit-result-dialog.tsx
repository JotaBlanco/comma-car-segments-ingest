"use client";

/**
 * The edit half of a processed result — `PATCH /results/{result_id}`.
 *
 * It follows `edit-run-dialog.tsx`: the Portal identity signs the change, the
 * journal records it, and an emptied box counts as no change.
 *
 * One field set stays out of this form. The route forbids an unknown key and
 * answers 422, and `result_id`, `run_id`, `result_key`, `version`,
 * `supersedes`, `storage_ref`, `provenance_status` and `created_at` are
 * identity, lineage or a stored verdict. The form never sends them.
 */

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
import { useActor, usePatchResult } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import type { ProcessedResult, ProvenancePatch, ResultPatchBody } from "@/types";

interface EditResultDialogProps {
  result: ProcessedResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One sentence a person can act on, per refusal the route answers. */
const FAILURES: Record<string, string> = {
  no_fields_to_update:
    "Nothing changed, so the registry stored nothing. Edit a field and save again.",
  result_not_found:
    "The registry holds no result under this id any more. Close this dialog and reload the screen.",
  provenance_required:
    "A provenance value came through blank. The tool, the version, the parameters, the inputs, the producer and the produced time must all stay filled. Put the value back, then save.",
  validation_error:
    "The registry refused a value. Check the produced time reads as an ISO-8601 UTC stamp, and check the producer names a known person.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused the edit: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The edit never reached the registry. Check the connection and try again.";
}

/** The plain text fields of the body, outside `provenance`. */
const TOP_FIELDS = [
  { key: "name", label: "Name", placeholder: "cycle_aggregates.parquet" },
  { key: "description", label: "Description", placeholder: "Cycle-level aggregates" },
] as const;

/** The single-line provenance fields. `parameters` gets a Textarea below. */
const PROVENANCE_FIELDS = [
  { key: "tool", label: "Tool", placeholder: "bat-post" },
  { key: "tool_version", label: "Tool version", placeholder: "2.3.1" },
  { key: "produced_by", label: "Produced by", placeholder: "E. Lindqvist" },
  { key: "produced_at", label: "Produced at (ISO-8601 UTC)", placeholder: "2026-08-14T12:02:00Z" },
] as const;

type ProvenanceField = (typeof PROVENANCE_FIELDS)[number]["key"];

const fieldClass = "text-[0.7rem] font-semibold text-ink-2";

/** Split a typed list of file ids. It drops the blanks, so a stray comma is safe. */
function parseInputIds(typed: string): string[] {
  return typed
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function EditResultDialog({ result, open, onOpenChange }: EditResultDialogProps) {
  const [name, setName] = useState(result.name);
  const [description, setDescription] = useState(result.description ?? "");
  const [provenance, setProvenance] = useState<Record<ProvenanceField, string>>({
    tool: result.provenance.tool,
    tool_version: result.provenance.tool_version,
    produced_by: result.provenance.produced_by,
    produced_at: result.provenance.produced_at,
  });
  const [parameters, setParameters] = useState(result.provenance.parameters);
  const [inputIds, setInputIds] = useState(result.provenance.input_file_ids.join(", "));
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The journal names the person who made the change, so the edit needs a
  // signed-in Quix Portal identity and never a typed default.
  const actor = useActor();
  const patchResult = usePatchResult(result.result_id, result.run_id, actor);

  /* The route offers no "clear a field" semantics, so an emptied box counts as
     no change. Sending "" would store an empty string instead, and a blank
     provenance value answers 422 `provenance_required`. */
  const changes: Omit<ResultPatchBody, "actor"> = {};
  const typedName = name.trim();
  if (typedName.length > 0 && typedName !== result.name) changes.name = typedName;
  const typedDescription = description.trim();
  if (typedDescription.length > 0 && typedDescription !== (result.description ?? "")) {
    changes.description = typedDescription;
  }

  const provenanceChanges: ProvenancePatch = {};
  for (const field of PROVENANCE_FIELDS) {
    const typed = provenance[field.key].trim();
    if (typed.length > 0 && typed !== result.provenance[field.key]) {
      provenanceChanges[field.key] = typed;
    }
  }
  const typedParameters = parameters.trim();
  if (typedParameters.length > 0 && typedParameters !== result.provenance.parameters) {
    provenanceChanges.parameters = typedParameters;
  }
  const typedInputs = parseInputIds(inputIds);
  if (
    typedInputs.length > 0 &&
    typedInputs.join(",") !== result.provenance.input_file_ids.join(",")
  ) {
    provenanceChanges.input_file_ids = typedInputs;
  }
  if (Object.keys(provenanceChanges).length > 0) changes.provenance = provenanceChanges;

  const changed = Object.keys(changes).length > 0;

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) setFailure(null);
  };

  const submit = () => {
    if (actor === null) return;
    if (!changed) {
      setFailure("Nothing changed yet. Edit a field, then save.");
      return;
    }
    setFailure(null);
    const trimmedNote = note.trim();
    patchResult.mutate(trimmedNote.length > 0 ? { ...changes, note: trimmedNote } : changes, {
      onSuccess: () => {
        toast(`${result.name}: the registry stored the edit and the journal records it`);
        setNote("");
        close(false);
      },
      onError: (error) => setFailure(messageFor(error)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[10px] p-5 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Edit {result.name}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            A provenance block records what a tool did. Once a person can rewrite the tool, the
            version and the parameters, the block states what somebody <b>says</b> the tool did. So
            the result takes an <b>Edited by hand</b> mark, and the journal keeps the old value, the
            new value and your name. An emptied box counts as no change.
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

        <div className="grid gap-3">
          {TOP_FIELDS.map((field) => (
            <div key={field.key} className="grid gap-1">
              <label htmlFor={`result-${field.key}`} className={fieldClass}>
                {field.label}
              </label>
              <Input
                id={`result-${field.key}`}
                value={field.key === "name" ? name : description}
                placeholder={field.placeholder}
                className="text-[0.8rem]"
                onChange={(event) => {
                  if (field.key === "name") setName(event.target.value);
                  else setDescription(event.target.value);
                  setFailure(null);
                }}
              />
            </div>
          ))}

          {PROVENANCE_FIELDS.map((field) => (
            <div key={field.key} className="grid gap-1">
              <label htmlFor={`result-${field.key}`} className={fieldClass}>
                {field.label}
              </label>
              <Input
                id={`result-${field.key}`}
                value={provenance[field.key]}
                placeholder={field.placeholder}
                className="text-[0.8rem]"
                onChange={(event) => {
                  const next = event.target.value;
                  setProvenance((previous) => ({ ...previous, [field.key]: next }));
                  setFailure(null);
                }}
              />
            </div>
          ))}

          <div className="grid gap-1">
            <label htmlFor="result-parameters" className={fieldClass}>
              Parameters
            </label>
            {/* A Textarea and not an Input: this box holds SQL or a command
                line, and it must keep its own line breaks. */}
            <Textarea
              id="result-parameters"
              value={parameters}
              placeholder="SELECT cycle, max(temp) FROM …"
              className="min-h-[110px] font-mono text-[0.75rem]"
              onChange={(event) => {
                setParameters(event.target.value);
                setFailure(null);
              }}
            />
          </div>

          <div className="grid gap-1">
            <label htmlFor="result-input_file_ids" className={fieldClass}>
              Input files <span className="font-normal text-ink-3">(file ids, comma separated)</span>
            </label>
            <Textarea
              id="result-input_file_ids"
              value={inputIds}
              placeholder="f-1111…, f-2222…"
              className="min-h-[60px] font-mono text-[0.75rem]"
              onChange={(event) => {
                setInputIds(event.target.value);
                setFailure(null);
              }}
            />
          </div>

          <div className="grid gap-1">
            <label htmlFor="result-note" className={fieldClass}>
              Note <span className="font-normal text-ink-3">(optional, joins the journal entry)</span>
            </label>
            <Textarea
              id="result-note"
              value={note}
              placeholder="e.g. the tool version was typed wrong at upload"
              className="min-h-[60px] bg-surface-2 text-[0.8rem] focus-visible:bg-surface"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[0.74rem] text-ink-3">
            Journalled as{" "}
            <span className="font-mono text-[0.74rem] text-ink-2">
              {actor ?? "nobody — sign in first"}
            </span>
            . The name comes from your Quix Portal profile.
          </div>
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
          <Button size="sm" disabled={actor === null || patchResult.isPending} onClick={submit}>
            {patchResult.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
