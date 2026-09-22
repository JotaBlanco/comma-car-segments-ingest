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
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { useActor, usePatchRequirement, useRequirement } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import { requirementOrigin, type RequirementDetail, type RequirementPatchBody } from "@/types";
import {
  RequirementFormFields,
  joinList,
  splitList,
  type RequirementFormValues,
} from "./requirement-form-fields";

/**
 * Edit a manual requirement's authored fields (authoring-controls §6, §7).
 * `requirementOrigin(detail)` reads `field_sources.title.source` — the
 * committed API has no flat "row origin" field, so this is the per-field
 * provenance every other entity detail already carries, read off one
 * canonical field. A planning-sourced row still opens this dialog (the list
 * cannot know origin in advance — see the architecture doc), but the form
 * renders only once the detail confirms `manual` (§4's rule: a control
 * renders only where a source can legally own the write, otherwise it is
 * absent).
 *
 * Mounted on demand, the way `AddNoteDialog` is — the parent renders this
 * only while a requirement is being edited, so `useRequirement` fires
 * exactly once per open and the screen asks the registry nothing while shut.
 */

const FAILURES: Record<string, string> = {
  stale_parent:
    "This requirement changed since you opened it. Reload and reapply your edit.",
  no_op_mint: "Nothing changed, so the registry stored nothing.",
  requirement_not_found: "The registry holds no requirement under this id any more.",
  validation_error: "The registry refused a value. Check each field and save again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused the edit: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The edit never reached the registry. Check the connection and try again.";
}

const measuredMethods = new Set(["test", "tests"]);

function valuesOf(detail: RequirementDetail): RequirementFormValues {
  return {
    title: detail.title,
    text: detail.text,
    chapter: detail.chapter ?? "",
    ears_pattern: detail.ears_pattern ?? "Ubiquitous",
    system_states: joinList(detail.system_states),
    rationale: detail.rationale ?? "",
    source: joinList(detail.source),
    verification_method: detail.verification_method ?? "",
    measurand: detail.measurand,
    revision: detail.revision ?? "",
    figure_refs: joinList(detail.figure_refs),
    related_reqs: joinList(detail.related_reqs),
    verification_criteria: detail.verification_criteria ?? "",
    status: detail.status,
  };
}

function sameMeasurand(
  a: readonly { name: string; unit: string }[],
  b: readonly { name: string; unit: string }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => row.name === b[index].name && row.unit === b[index].unit);
}

/**
 * Only the fields whose form value differs from the loaded detail — a
 * person edits one or two fields, and the route journals one entry per
 * field that actually moved. `status` is never diffed here: the committed
 * `RequirementPatchRequest` carries no `status` field at all (a status move
 * is not this route's job), and `RequestModel`'s `extra="forbid"` would
 * 422 the whole request if it rode along.
 */
function diff(
  detail: RequirementDetail,
  values: RequirementFormValues,
): Omit<RequirementPatchBody, "actor" | "parent_version"> {
  const changes: Omit<RequirementPatchBody, "actor" | "parent_version"> = {};
  if (values.title.trim().length > 0 && values.title.trim() !== detail.title) {
    changes.title = values.title.trim();
  }
  if (values.text.trim().length > 0 && values.text.trim() !== detail.text) {
    changes.text = values.text.trim();
  }
  if (values.chapter.trim().length > 0 && values.chapter.trim() !== (detail.chapter ?? "")) {
    changes.chapter = values.chapter.trim();
  }
  if (values.ears_pattern !== (detail.ears_pattern ?? undefined)) {
    changes.ears_pattern = values.ears_pattern;
  }
  if (
    values.verification_method.trim().length > 0 &&
    values.verification_method.trim() !== (detail.verification_method ?? "")
  ) {
    changes.verification_method = values.verification_method.trim();
  }
  if (values.revision.trim().length > 0 && values.revision.trim() !== (detail.revision ?? "")) {
    changes.revision = values.revision.trim();
  }
  if (values.rationale.trim().length > 0 && values.rationale.trim() !== (detail.rationale ?? "")) {
    changes.rationale = values.rationale.trim();
  }
  if (
    values.verification_criteria.trim().length > 0 &&
    values.verification_criteria.trim() !== (detail.verification_criteria ?? "")
  ) {
    changes.verification_criteria = values.verification_criteria.trim();
  }
  const systemStates = splitList(values.system_states);
  if (joinList(systemStates) !== joinList(detail.system_states)) changes.system_states = systemStates;
  const source = splitList(values.source);
  if (joinList(source) !== joinList(detail.source)) changes.source = source;
  const figureRefs = splitList(values.figure_refs);
  if (joinList(figureRefs) !== joinList(detail.figure_refs)) changes.figure_refs = figureRefs;
  const relatedReqs = splitList(values.related_reqs);
  if (joinList(relatedReqs) !== joinList(detail.related_reqs)) changes.related_reqs = relatedReqs;
  const measurand = measuredMethods.has(values.verification_method.trim().toLowerCase())
    ? values.measurand.filter((m) => m.name.trim().length > 0 && m.unit.trim().length > 0)
    : [];
  if (!sameMeasurand(measurand, detail.measurand)) changes.measurand = measurand;
  return changes;
}

interface EditRequirementDialogProps {
  readonly reqId: string;
  onClose: () => void;
}

export function EditRequirementDialog({ reqId, onClose }: EditRequirementDialogProps) {
  const { data: detail, isPending, error } = useRequirement(reqId);
  const [values, setValues] = useState<RequirementFormValues | null>(null);
  const [secondActor, setSecondActor] = useState("");
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const actor = useActor();
  const patchRequirement = usePatchRequirement(reqId, actor);

  /* Seed the form once the detail arrives, without an effect: `loadedFrom`
     tracks which detail object last seeded `values`, adjusted during render
     the way `definitions-screen.tsx` resets its page on a prop change — a
     setState call in an effect body would cascade an extra render for no
     reason a person can see. Once seeded, further edits are local state an
     unrelated re-render of `detail` (a background refetch) must not clobber. */
  const [loadedFrom, setLoadedFrom] = useState<RequirementDetail | undefined>(undefined);
  if (detail !== undefined && detail !== loadedFrom && values === null) {
    setLoadedFrom(detail);
    setValues(valuesOf(detail));
  }

  const needsSecondActor = detail?.status === "Reviewed";
  const editable = detail !== undefined && requirementOrigin(detail) === "manual";

  const submit = () => {
    if (actor === null || detail === undefined || values === null) return;
    if (needsSecondActor && secondActor.trim().length === 0) {
      setFailure("This requirement is Reviewed — a second reviewer's name is required to save.");
      return;
    }
    const changes = diff(detail, values);
    if (Object.keys(changes).length === 0) {
      setFailure("Nothing changed yet. Edit a field, then save.");
      return;
    }
    setFailure(null);
    const trimmedNote = note.trim();
    patchRequirement.mutate(
      {
        ...changes,
        parent_version: detail.item_version,
        ...(needsSecondActor ? { second_actor: secondActor.trim() } : {}),
        ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
      },
      {
        onSuccess: () => {
          toast(`${reqId}: ${Object.keys(changes).join(", ")} saved`);
          onClose();
        },
        onError: (submitError) => setFailure(messageFor(submitError)),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[10px] p-5 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Edit {reqId}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            Each saved field takes the source <b>manual</b>, and the journal records the old
            value, the new value and your name. An emptied text box counts as no change.
          </DialogDescription>
        </DialogHeader>

        {isPending && (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}

        {error !== null && !isPending && (
          <div role="alert" className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-red">
            This requirement did not load. Close the dialog and try again.
          </div>
        )}

        {detail !== undefined && !editable && (
          <div role="alert" className="rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2">
            This row is mirrored from planning — its authored fields are edited there, not here.
          </div>
        )}

        {actor === null && (
          <div role="alert" className="rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2">
            {NO_ACTOR_MESSAGE}
          </div>
        )}

        {detail !== undefined && editable && values !== null && (
          <>
            <RequirementFormFields values={values} onChange={setValues} showStatus={false} />

            {needsSecondActor && (
              <div className="grid gap-1">
                <label htmlFor="req-second-actor" className="text-[0.7rem] font-semibold text-ink-2">
                  Second reviewer — required while this requirement is Reviewed
                </label>
                <Input
                  id="req-second-actor"
                  value={secondActor}
                  placeholder="Name of the second reviewer"
                  className="text-[0.8rem]"
                  onChange={(event) => setSecondActor(event.target.value)}
                />
              </div>
            )}

            <div className="grid gap-1">
              <label htmlFor="req-edit-note" className="text-[0.7rem] font-semibold text-ink-2">
                Note <span className="font-normal text-ink-3">(optional, joins the journal entry)</span>
              </label>
              <Input
                id="req-edit-note"
                value={note}
                className="text-[0.8rem]"
                onChange={(event) => setNote(event.target.value)}
              />
            </div>

            <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[0.74rem] text-ink-3">
              Journalled as{" "}
              <span className="font-mono text-[0.74rem] text-ink-2">
                {actor ?? "nobody — sign in first"}
              </span>
              . Parent version <span className="font-mono">{detail.item_version}</span>.
            </div>
          </>
        )}

        {failure !== null && (
          <div role="alert" className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-red">
            {failure}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {editable && (
            <Button
              size="sm"
              disabled={actor === null || values === null || patchRequirement.isPending}
              onClick={submit}
            >
              {patchRequirement.isPending ? "Saving…" : "Save changes"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
