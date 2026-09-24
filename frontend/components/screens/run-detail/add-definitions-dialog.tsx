"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SingleSelect, type SingleSelectOption } from "@/components/shared/single-select";
import { DefinitionStatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAddRunDefinition,
  useRequirements,
  useTestDefinitions,
  useWorkOrders,
} from "@/lib/hooks";
import {
  ANY,
  NONE,
  buildDefinitionChoices,
  featuresOf,
  narrow,
  projectsOf,
  runDefinitionFailure,
  someUnresolved,
} from "./definition-choices";

/**
 * Put several test definitions on one run in a single confirm.
 *
 * Three reads, joined in the browser: the definitions are the rows, the work
 * orders give each one its project and the requirements give it its feature.
 * The registry holds tens of each, so one page of each is the whole estate —
 * the same join the traceability screen does.
 *
 * Add only. Every tick that is not already on the run becomes one
 * `POST /test-runs/{run_id}/definitions`, in order; a definition already on
 * the run is ticked and locked, and it comes off from its own row on the
 * panel. The route is per-member and idempotent, so a batch route would only
 * move this loop to the server.
 */

/** Every row of every list, in one page each. */
const PAGE_SIZE = 200;

function countedLabel(count: number): string {
  if (count === 0) return "Add test definitions";
  return count === 1 ? "Add 1 test definition" : `Add ${count} test definitions`;
}

function facetOptions(
  values: readonly string[],
  allLabel: string,
  noneLabel: string,
  withNone: boolean,
): SingleSelectOption[] {
  const options: SingleSelectOption[] = [{ value: ANY, label: allLabel }];
  for (const value of values) options.push({ value, label: value });
  if (withNone) options.push({ value: NONE, label: noneLabel });
  return options;
}

interface AddDefinitionsDialogProps {
  readonly runId: string;
  /** The run's own work order. Its project is where the dialog opens. */
  readonly workOrderId: string;
  /** The run's `definition_ids` — these render ticked and locked. */
  readonly present: readonly string[];
  onOpenChange: (open: boolean) => void;
}

export function AddDefinitionsDialog({
  runId,
  workOrderId,
  present,
  onOpenChange,
}: AddDefinitionsDialogProps) {
  const [chosenProject, setChosenProject] = useState<string | null>(null);
  const [feature, setFeature] = useState(ANY);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const requirements = useRequirements({ page_size: PAGE_SIZE });
  const definitions = useTestDefinitions({ page_size: PAGE_SIZE });
  const workOrders = useWorkOrders({ page_size: PAGE_SIZE });
  const addDefinition = useAddRunDefinition(runId);

  const choices = useMemo(
    () =>
      buildDefinitionChoices({
        requirements: requirements.data?.items ?? [],
        definitions: definitions.data?.items ?? [],
        workOrders: workOrders.data?.items ?? [],
        present,
      }),
    [requirements.data, definitions.data, workOrders.data, present],
  );

  const runProject =
    workOrders.data?.items.find((row) => row.wo_id === workOrderId)?.project ?? null;
  const project = chosenProject ?? (runProject !== null && runProject.length > 0 ? runProject : ANY);

  const underProject = narrow(choices, project, ANY);
  const rows = narrow(underProject, ANY, feature);

  const chosen = choices.filter((choice) => !choice.present && ticked.has(choice.tdId));
  const shownTicks = rows.filter((row) => !row.present && ticked.has(row.tdId)).length;
  const hiddenTicks = chosen.length - shownTicks;

  const reads = [requirements, definitions, workOrders];
  const pending = reads.some((read) => read.isPending);
  const failedRead = reads.some((read) => read.isError);

  const close = (open: boolean) => {
    if (submitting) return;
    onOpenChange(open);
  };

  const toggle = (tdId: string) => {
    setFailure(null);
    setTicked((previous) => {
      const next = new Set(previous);
      if (!next.delete(tdId)) next.add(tdId);
      return next;
    });
  };

  const submit = async () => {
    setFailure(null);
    setSubmitting(true);
    const landed: string[] = [];
    const refused: string[] = [];
    let reason = "";
    for (const choice of chosen) {
      try {
        await addDefinition.mutateAsync(choice.tdId);
        landed.push(choice.tdId);
      } catch (error) {
        refused.push(choice.tdId);
        reason = runDefinitionFailure(error);
      }
    }
    setSubmitting(false);
    setTicked(new Set(refused));
    if (refused.length === 0) {
      const noun = landed.length === 1 ? "test definition" : "test definitions";
      toast(`${landed.length} ${noun} added to ${runId}`);
      onOpenChange(false);
      return;
    }
    setFailure(
      landed.length === 0
        ? `Nothing was added. ${reason}`
        : `${landed.join(", ")} landed on the run. ${refused.join(", ")} did not: ${reason}`,
    );
  };

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Add test definitions to this run
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            Narrow by project and feature, then tick every test case this run covers. Ticking
            adds only — a definition already on the run is ticked and locked, and it comes off
            from its own row on the panel.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <SingleSelect
            label="Project"
            value={project}
            options={facetOptions(
              projectsOf(choices),
              "All projects",
              "No project",
              someUnresolved(choices, "project"),
            )}
            disabled={submitting}
            onChange={(next) => {
              setChosenProject(next);
              setFeature(ANY);
            }}
          />
          <SingleSelect
            label="Feature"
            value={feature}
            options={facetOptions(
              featuresOf(underProject),
              "All features",
              "No feature",
              someUnresolved(underProject, "feature"),
            )}
            disabled={submitting}
            onChange={setFeature}
          />
        </div>

        <div className="max-h-[22rem] overflow-y-auto rounded-md border border-line">
          {pending && (
            <div className="grid gap-2 px-3 py-3">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-52" />
              <Skeleton className="h-4 w-60" />
            </div>
          )}
          {failedRead && (
            <ErrorState
              message="The test definitions never arrived."
              onRetry={() => {
                void requirements.refetch();
                void definitions.refetch();
                void workOrders.refetch();
              }}
            />
          )}
          {!pending && !failedRead && rows.length === 0 && (
            <EmptyState
              title="No test definition here"
              message="Nothing mirrored matches this project and feature. Widen either selector."
            />
          )}
          {!pending &&
            !failedRead &&
            rows.map((row) => (
              <label
                key={row.tdId}
                className="group/field flex cursor-pointer items-start gap-2.5 border-b border-line-2 px-3 py-2 last:border-b-0 hover:bg-surface-2"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={row.present || ticked.has(row.tdId)}
                  disabled={row.present || submitting}
                  aria-label={
                    row.present
                      ? `${row.tdId} is already on this run`
                      : `Add ${row.tdId} to this run`
                  }
                  onCheckedChange={() => toggle(row.tdId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[0.78rem]">{row.tdId}</span>
                    <DefinitionStatusBadge status={row.status} />
                    {row.present && (
                      <span className="text-[0.68rem] font-semibold text-ink-3">
                        already on this run
                      </span>
                    )}
                  </span>
                  <span className="block text-[0.78rem] text-ink-2">{row.title}</span>
                  <span className="block text-[0.7rem] text-ink-3">
                    {row.chapters.length > 0 ? row.chapters.join(" · ") : "no chapter"} ·{" "}
                    {row.features.length > 0 ? row.features.join(" · ") : "no feature"}
                  </span>
                </span>
              </label>
            ))}
        </div>

        {failure !== null && (
          <div
            role="alert"
            className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-red"
          >
            {failure}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-[0.7rem] text-ink-3">
            {hiddenTicks > 0
              ? `${hiddenTicks} ticked outside this project and feature — the button adds those too.`
              : null}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={submitting} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={chosen.length === 0 || submitting}
              onClick={() => {
                void submit();
              }}
            >
              {submitting ? "Adding…" : countedLabel(chosen.length)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
