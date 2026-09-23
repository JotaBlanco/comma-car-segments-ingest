"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  CustomPropertiesEditor,
  PROPERTY_FAILURES,
  mapOf,
  propertyProblem,
  rowsOf,
  sameMap,
  type PropertyRow,
} from "@/components/shared/custom-properties-editor";
import { SourceBadge } from "@/components/shared/source-badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxStatus,
} from "@/components/ui/combobox";
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
import { formatArrival } from "@/lib/format";
import { useActor, usePatchRun, useWorkOrders } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import { sourced } from "@/types";
import type { RunPatchBody, TestRun, WorkOrderListItem } from "@/types";
import { PICKER_SEARCH_DEBOUNCE_MS, useDebouncedQuery } from "./use-debounced-query";

interface EditRunDialogProps {
  run: TestRun;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The free-text fields `PATCH /test-runs/{run_id}` accepts
 * (`api/api/routers/test_runs.py`). The form offers these and no other key,
 * because `RequestModel` sets `extra="forbid"` and answers 422 for the rest.
 *
 * The route also patches `work_order_id` and `definition_id`. `work_order_id`
 * gets the picker below, never a text box: the route checks the id against the
 * mirrored work orders and answers 422 `unknown_work_order` for the rest, and a
 * person cannot act on that refusal. `definition_id` stays out of this form
 * because that one id REPLACES the run's whole set (`_resolve_manual_links`,
 * `api/api/services/queries_runs.py`), so a run covering three definitions
 * would silently lose two. The run screen's "Test definitions this run covers"
 * panel adds and removes one member at a time instead.
 */
const FIELDS = [
  { key: "description", label: "Description", placeholder: "E-machine efficiency map" },
  { key: "operator", label: "Operator", placeholder: "S. Vidal" },
  { key: "bench_sw", label: "Bench SW at run time", placeholder: "TAS 7.4.3 · fw 2.12" },
] as const;

type EditableField = (typeof FIELDS)[number]["key"];

/** One page of picker matches. 200 is the largest allowed page, and the
    combobox narrows by `?q=` server-side, so no mirrored work order is ever
    out of reach — the old `<select>` truncated at the first 200. */
const WORK_ORDER_PAGE_SIZE = 200;

/** One sentence a person can act on, per refusal the route answers. */
const FAILURES: Record<string, string> = {
  no_fields_to_update: "Nothing changed, so the registry stored nothing. Edit a field and save again.",
  run_not_found: "The registry holds no run under this id any more. Reload the screen.",
  validation_error: "The registry refused a value. Check each field and save again.",
  unknown_work_order:
    "The registry mirrors no work order under that id any more. Reopen this dialog and pick again.",
  unknown_definition:
    "The registry mirrors no test definition under that id. Run a planning sync, then try again.",
  // The property refusals are the shared editor's, because the API answers the
  // same codes to the run and to the test definition.
  ...PROPERTY_FAILURES,
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused the edit: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The edit never reached the registry. Check the connection and try again.";
}

const fieldClass = "text-[0.7rem] font-semibold text-ink-2";

export function EditRunDialog({ run, open, onOpenChange }: EditRunDialogProps) {
  const [values, setValues] = useState<Record<EditableField, string>>({
    description: run.description ?? "",
    operator: run.operator ?? "",
    bench_sw: run.bench_sw ?? "",
  });
  const [workOrderId, setWorkOrderId] = useState(run.work_order_id ?? "");
  // The body comes off the network, so an older API build may send no key.
  const storedProperties = run.custom_properties ?? {};
  const [rows, setRows] = useState<PropertyRow[]>(() => rowsOf(storedProperties));
  const [workOrderQuery, setWorkOrderQuery] = useState("");
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The journal names the person who made the change, so the edit needs a
  // signed-in Quix Portal identity and never a typed default.
  const actor = useActor();
  const patchRun = usePatchRun(run.run_id, actor);
  // Only a mirrored work order is a legal link, so the picker reads the mirror.
  // The typed text becomes a server-side `?q=` (debounced), so every mirrored
  // work order is reachable — not only the first page. A closed dialog asks
  // for nothing.
  const debouncedQuery = useDebouncedQuery(workOrderQuery.trim(), PICKER_SEARCH_DEBOUNCE_MS);
  const workOrders = useWorkOrders(
    debouncedQuery.length > 0
      ? { page_size: WORK_ORDER_PAGE_SIZE, q: debouncedQuery }
      : { page_size: WORK_ORDER_PAGE_SIZE },
    open
  );
  const workOrderItems = workOrders.data?.items ?? [];

  const current: Record<EditableField, string | null> = {
    description: run.description,
    operator: run.operator,
    bench_sw: run.bench_sw,
  };
  const workOrderProvenance = sourced(run, "work_order_id");
  const propertyProvenance = sourced(run, "custom_properties");

  /* The route offers no "clear a field" semantics, so an emptied box counts as
     no change. Sending "" would store an empty string instead. */
  const changes: Omit<RunPatchBody, "actor"> = {};
  for (const field of FIELDS) {
    const typed = values[field.key].trim();
    if (typed.length > 0 && typed !== (current[field.key] ?? "")) changes[field.key] = typed;
  }
  /* The route counts a null link as absent, so it cannot unlink a run. The
     picker therefore offers no "none" option, and an unchanged pick sends
     nothing. */
  if (workOrderId.length > 0 && workOrderId !== (run.work_order_id ?? "")) {
    changes.work_order_id = workOrderId;
  }
  /* The map replaces the stored map whole, so a removed row IS a change and an
     empty editor clears every property. That is the opposite of the emptied
     box above, and the editor says so. */
  const properties = mapOf(rows);
  const propertiesChanged = !sameMap(properties, storedProperties);
  if (propertiesChanged) changes.custom_properties = properties;
  const changed = Object.keys(changes).length > 0;

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) setFailure(null);
  };

  const submit = () => {
    if (actor === null) return;
    /* The property check runs first. Two rows of one name collapse into one
       pair, so the map alone can read as "nothing changed" while the editor
       clearly holds a mistake. */
    const problem = propertyProblem(rows);
    if (problem !== null) {
      setFailure(problem);
      return;
    }
    if (!changed) {
      setFailure("Nothing changed yet. Edit a field, then save.");
      return;
    }
    setFailure(null);
    const trimmedNote = note.trim();
    patchRun.mutate(
      trimmedNote.length > 0 ? { ...changes, note: trimmedNote } : changes,
      {
        onSuccess: () => {
          const names = Object.keys(changes).join(", ");
          toast(`${run.run_id}: ${names} now reads manual — the journal records the change`);
          setNote("");
          close(false);
        },
        onError: (error) => setFailure(messageFor(error)),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[10px] p-5 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Edit the metadata of {run.run_id}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            Each saved field takes the source <b>manual</b>, and the journal records the old value,
            the new value and your name. An emptied text box counts as no change. A removed custom
            property is a change.
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
            const provenance = sourced(run, field.key);
            return (
              <div key={field.key} className="grid gap-1">
                <label
                  htmlFor={`run-${field.key}`}
                  className={`${fieldClass} flex items-center gap-1.5`}
                >
                  {field.label}
                  {provenance.source !== null && <SourceBadge source={provenance.source} />}
                </label>
                <Input
                  id={`run-${field.key}`}
                  value={values[field.key]}
                  placeholder={field.placeholder}
                  className="text-[0.8rem]"
                  onChange={(event) => {
                    setValues((previous) => ({ ...previous, [field.key]: event.target.value }));
                    setFailure(null);
                  }}
                />
                {provenance.source !== null && provenance.actor !== undefined && (
                  <div className="text-[0.7rem] text-ink-3">
                    last set by {provenance.actor}
                    {provenance.at !== undefined && `, ${formatArrival(provenance.at)}`}
                  </div>
                )}
              </div>
            );
          })}

          <div className="grid gap-1">
            <label
              htmlFor="run-work_order_id"
              className={`${fieldClass} flex items-center gap-1.5`}
            >
              Work order
              {workOrderProvenance.source !== null && (
                <SourceBadge source={workOrderProvenance.source} />
              )}
            </label>
            {/* Single-select combobox over GET /work-orders?q= — the typed
                text searches the WHOLE mirror server-side, so the picker no
                longer truncates at the first page. The server already
                filters, so the client-side filter is off. */}
            <Combobox
              items={workOrderItems}
              filter={null}
              itemToStringLabel={(workOrder: WorkOrderListItem) => workOrder.wo_id}
              isItemEqualToValue={(a: WorkOrderListItem, b: WorkOrderListItem) =>
                a.wo_id === b.wo_id
              }
              onInputValueChange={(text) => setWorkOrderQuery(text)}
              onValueChange={(workOrder: WorkOrderListItem | null) => {
                /* The route cannot unlink a run, so a cleared box only means
                   "keep the current link". It never becomes a request. */
                setWorkOrderId(workOrder?.wo_id ?? "");
                setFailure(null);
              }}
            >
              <ComboboxInput
                id="run-work_order_id"
                placeholder={
                  run.work_order_id === null ? "No work order yet" : "Keep the current link"
                }
                className="text-[0.8rem]"
              />
              <ComboboxContent>
                <ComboboxStatus>
                  {workOrders.isFetching ? "Searching the mirror…" : null}
                </ComboboxStatus>
                <ComboboxEmpty>
                  {workOrders.isError
                    ? "The work order list never arrived. Reload the screen."
                    : "No mirrored work order matches."}
                </ComboboxEmpty>
                <ComboboxList>
                  {(workOrder: WorkOrderListItem) => (
                    <ComboboxItem key={workOrder.wo_id} value={workOrder}>
                      <span className="truncate text-[0.8rem]">
                        <span className="font-mono">{workOrder.wo_id}</span> · {workOrder.title}
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <div className="text-[0.7rem] text-ink-3">
              {workOrders.isError
                ? "The work order list never arrived, so no link can change. Reload the screen."
                : "Type to search every mirrored work order. The project follows the work order, so the registry sets it for you."}
            </div>
          </div>

          <div className="grid gap-1.5">
            <span className={`${fieldClass} flex items-center gap-1.5`}>
              Custom properties
              {propertyProvenance.source !== null && (
                <SourceBadge source={propertyProvenance.source} />
              )}
            </span>
            <p className="text-[0.7rem] text-ink-3">
              Free name and value pairs. Remove a row to delete that property. A removal is a
              change, and it is not an emptied box.
            </p>

            <CustomPropertiesEditor
              rows={rows}
              onRowsChange={(next) => {
                setRows(next);
                setFailure(null);
              }}
              emptyMessage="This run carries no custom property."
            />
          </div>

          <div className="grid gap-1">
            <label htmlFor="run-note" className={fieldClass}>
              Note <span className="font-normal text-ink-3">(optional, joins the journal entry)</span>
            </label>
            <Textarea
              id="run-note"
              value={note}
              placeholder="e.g. set from the shift roster"
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
          <Button size="sm" disabled={actor === null || patchRun.isPending} onClick={submit}>
            {patchRun.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
