"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Panel, PanelHead } from "@/components/shared/panel";
import { DefinitionStatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api/client";
import { planRunAll, type RowRunState } from "@/lib/definition-run";
import { useAddRunDefinition, useRemoveRunDefinition, useWorkOrder } from "@/lib/hooks";
import type { TestRun, WorkOrderDefinition } from "@/types";
import { DefinitionPicker } from "./definition-picker";
import { DefinitionRunCell } from "./definition-run-cell";

/** One sentence a person can act on, per refusal the two routes answer. */
const FAILURES: Record<string, string> = {
  run_not_found: "The registry holds no run under this id any more. Reload the screen.",
  unknown_definition:
    "The registry mirrors no test definition under that id. Run a planning sync, then try again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused it: ${error.detail}`;
  }
  return "The change never reached the registry. Check the connection and try again.";
}

function sameRowState(a: RowRunState | undefined, b: RowRunState): boolean {
  return a?.runnable === b.runnable && a.pending === b.pending && a.loading === b.loading;
}

/** Title and status of one covered definition, or what stands in for them. */
function DefinitionCells({
  definition,
  resolving,
}: {
  definition: WorkOrderDefinition | undefined;
  resolving: boolean;
}) {
  if (resolving) {
    return (
      <>
        <TableCell>
          <Skeleton className="h-3.5 w-48" />
        </TableCell>
        <TableCell>
          <Skeleton className="h-3.5 w-20" />
        </TableCell>
      </>
    );
  }
  if (definition === undefined) {
    // One line for every way an id resolves to nothing: the work order is not
    // mirrored, it mirrors no such definition, or its read failed.
    return (
      <TableCell colSpan={2} className="text-ink-3">
        no mirrored definition under this id
      </TableCell>
    );
  }
  return (
    <>
      <TableCell className="whitespace-normal">{definition.title}</TableCell>
      <TableCell>
        <DefinitionStatusBadge status={definition.status} />
      </TableCell>
    </>
  );
}

/**
 * The test definitions one run covers, and the controls that assign them.
 *
 * `definition_ids` is the run's whole set and the ids alone render without any
 * further read. The titles come from the run's work order, which mirrors one
 * row per definition, so one request resolves every title — and it is the read
 * the work-order screen has usually cached already.
 *
 * Add and remove each move ONE member (`POST`/`DELETE
 * /test-runs/{run_id}/definitions`) and answer the whole run, so the panel
 * redraws from the answer. Both are no-ops on a member already there or
 * already gone, so neither control checks the set before it calls.
 */
export function DefinitionsPanel({ run }: { run: TestRun }) {
  const ids = run.definition_ids ?? [];
  const [picking, setPicking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const addDefinition = useAddRunDefinition(run.run_id);
  const removeDefinition = useRemoveRunDefinition(run.run_id);

  const [runAllToken, setRunAllToken] = useState(0);
  const [rowStates, setRowStates] = useState<ReadonlyMap<string, RowRunState>>(new Map());
  const reportRow = useCallback((tdId: string, state: RowRunState | null) => {
    setRowStates((previous) => {
      if (state === null ? !previous.has(tdId) : sameRowState(previous.get(tdId), state)) {
        return previous;
      }
      const next = new Map(previous);
      if (state === null) next.delete(tdId);
      else next.set(tdId, state);
      return next;
    });
  }, []);
  const runAll = planRunAll(ids, rowStates);

  // No ids, nothing to resolve: the empty string keeps the query disabled.
  const workOrderQuery = useWorkOrder(ids.length > 0 ? (run.work_order_id ?? "") : "");
  const mirrored = new Map<string, WorkOrderDefinition>(
    (workOrderQuery.data?.definitions ?? []).map((definition) => [definition.td_id, definition]),
  );

  const add = (tdId: string) => {
    setFailure(null);
    addDefinition.mutate(tdId, {
      onSuccess: () => setPicking(false),
      onError: (error) => setFailure(messageFor(error)),
    });
  };

  const remove = (tdId: string) => {
    setFailure(null);
    removeDefinition.mutate(tdId, { onError: (error) => setFailure(messageFor(error)) });
  };

  return (
    <Panel className="mt-4">
      <PanelHead
        title="Test definitions this run covers"
        action={
          <div className="flex items-center gap-3">
            {ids.length > 0 && (
              <span className="font-mono text-[0.68rem] text-ink-3">{ids.length} covered</span>
            )}
            {ids.length > 0 && (
              <Button
                variant="outline"
                size="xs"
                className="font-semibold"
                disabled={runAll.blocked !== null}
                title={
                  runAll.blocked ??
                  "Runs every definition with an implementation on this run, one QuixLab Job each"
                }
                onClick={() => setRunAllToken((token) => token + 1)}
              >
                Run all ({runAll.count})
              </Button>
            )}
            <Button
              variant="outline"
              size="xs"
              disabled={picking}
              onClick={() => {
                setFailure(null);
                setPicking(true);
              }}
            >
              Add definition
            </Button>
          </div>
        }
      />
      {picking && (
        <DefinitionPicker
          workOrderId={run.work_order_id ?? ""}
          pending={addDefinition.isPending}
          onPick={add}
          onCancel={() => setPicking(false)}
        />
      )}
      <p className="border-b border-line-2 px-4 py-2 text-[0.7rem] text-ink-3">
        Assigning a definition here makes this run&rsquo;s set manual — a later planning sync
        leaves it alone.
      </p>
      {failure !== null && (
        <div
          role="alert"
          className="border-b border-line-2 px-4 py-2 text-[0.76rem] text-red"
        >
          {failure}
        </div>
      )}
      <Table aria-label="Test definitions this run covers">
        <TableHeader>
          <TableRow>
            <TableHead>Definition</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Run</TableHead>
            <TableHead>
              <span className="sr-only">Remove</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ids.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={5} className="p-0!">
                <EmptyState
                  title="No test definitions on this run"
                  message="Nothing says yet which test cases this run answers. Press Add definition to assign one."
                />
              </TableCell>
            </TableRow>
          )}
          {ids.map((tdId) => (
            <TableRow key={tdId} className="hover:bg-transparent">
              <TableCell>
                <Link
                  href={`/definitions/${encodeURIComponent(tdId)}`}
                  className="font-mono text-[0.78rem] text-primary hover:underline"
                >
                  {tdId}
                </Link>
              </TableCell>
              <DefinitionCells
                definition={mirrored.get(tdId)}
                resolving={workOrderQuery.isLoading}
              />
              <DefinitionRunCell
                runId={run.run_id}
                tdId={tdId}
                runAllToken={runAllToken}
                onRunState={reportRow}
              />
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${tdId} from this run`}
                  disabled={removeDefinition.isPending}
                  onClick={() => remove(tdId)}
                >
                  <X />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
