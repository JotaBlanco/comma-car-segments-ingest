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
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/client";
import { useActor, usePatchSignal, useSignalFacets } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import { sourced } from "@/types";
import type { SignalDetail, SignalPatchBody } from "@/types";
import { formatDay } from "./format";

interface EditSignalDialogProps {
  signal: SignalDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The three fields `PATCH /signals/{name}` accepts today
 * (`api/api/routers/signals.py`). `catalogue_ref` is catalog-owned and the
 * request model refuses it, so the form never offers it.
 */
const FIELDS = [
  { key: "unit", label: "Unit", placeholder: "Nm" },
  { key: "description", label: "Description", placeholder: "Hottest cell temperature" },
  { key: "sensor_ref", label: "Sensor ref", placeholder: "RIG-04-TC-17" },
] as const;

type EditableField = (typeof FIELDS)[number]["key"];

/** One sentence a person can act on, per refusal the route answers. */
const FAILURES: Record<string, string> = {
  no_fields_to_update:
    "Nothing changed, so the catalog stored nothing. Edit a field and save again.",
  signal_not_found: "The catalog holds no signal under this name any more. Reload the screen.",
  validation_error: "The catalog refused a value. Check each field and save again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The catalog refused the edit: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The edit never reached the catalog. Check the connection and try again.";
}

const fieldClass = "text-[0.7rem] font-semibold text-ink-2";

export function EditSignalDialog({ signal, open, onOpenChange }: EditSignalDialogProps) {
  const [values, setValues] = useState<Record<EditableField, string>>({
    unit: signal.unit ?? "",
    description: signal.description ?? "",
    sensor_ref: signal.sensor_ref ?? "",
  });
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The journal names the person who made the change, so the edit needs a
  // signed-in Quix Portal identity and never a typed default.
  const actor = useActor();
  const patchSignal = usePatchSignal(signal.name, actor);
  /* The whole catalog's units feed the unit autocomplete (FR-DM-079a).
     They suggest only — any typed unit stays legal. */
  const units = useSignalFacets().data?.units ?? [];

  const current: Record<EditableField, string | null> = {
    unit: signal.unit,
    description: signal.description,
    sensor_ref: signal.sensor_ref,
  };

  /* The route offers no "clear a field" semantics, so an emptied box counts as
     no change. Sending an empty string would store an empty value instead. */
  const changes: Omit<SignalPatchBody, "actor"> = {};
  for (const field of FIELDS) {
    const typed = values[field.key].trim();
    if (typed.length > 0 && typed !== (current[field.key] ?? "")) changes[field.key] = typed;
  }
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
    patchSignal.mutate(trimmedNote.length > 0 ? { ...changes, note: trimmedNote } : changes, {
      onSuccess: () => {
        const names = Object.keys(changes).join(", ");
        toast(`${signal.name}: ${names} now reads manual — the journal records the change`);
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
            Edit the catalog entry for {signal.name}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            Each saved field takes the source <b>manual</b>, and the journal records the old value,
            the new value and your name. An emptied box counts as no change.
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
          {FIELDS.map((field) => {
            const provenance = sourced(signal, field.key);
            return (
              <div key={field.key} className="grid gap-1">
                <label
                  htmlFor={`signal-${field.key}`}
                  className={`${fieldClass} flex items-center gap-1.5`}
                >
                  {field.label}
                </label>
                {field.key === "unit" ? (
                  <Autocomplete
                    items={units}
                    value={values.unit}
                    onValueChange={(next) => {
                      setValues((previous) => ({ ...previous, unit: next }));
                      setFailure(null);
                    }}
                  >
                    <AutocompleteInput
                      id="signal-unit"
                      placeholder={field.placeholder}
                      className="text-[0.8rem]"
                    />
                    <AutocompleteContent>
                      <AutocompleteList>
                        {(unit: string) => (
                          <AutocompleteItem
                            key={unit}
                            value={unit}
                            className="font-mono text-[0.78rem]"
                          >
                            {unit}
                          </AutocompleteItem>
                        )}
                      </AutocompleteList>
                    </AutocompleteContent>
                  </Autocomplete>
                ) : (
                  <Input
                    id={`signal-${field.key}`}
                    value={values[field.key]}
                    placeholder={field.placeholder}
                    className="text-[0.8rem]"
                    onChange={(event) => {
                      setValues((previous) => ({ ...previous, [field.key]: event.target.value }));
                      setFailure(null);
                    }}
                  />
                )}
                {provenance.source !== null && provenance.actor !== undefined && (
                  <div className="text-[0.7rem] text-ink-3">
                    last set by {provenance.actor}
                    {provenance.at !== undefined && `, ${formatDay(provenance.at)}`}
                  </div>
                )}
              </div>
            );
          })}

          <div className="grid gap-1">
            <label htmlFor="signal-note" className={fieldClass}>
              Note{" "}
              <span className="font-normal text-ink-3">(optional, joins the journal entry)</span>
            </label>
            <Textarea
              id="signal-note"
              value={note}
              placeholder="e.g. unit absent from the file header — set from the rig sensor sheet"
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
          <Button size="sm" disabled={actor === null || patchSignal.isPending} onClick={submit}>
            {patchSignal.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
