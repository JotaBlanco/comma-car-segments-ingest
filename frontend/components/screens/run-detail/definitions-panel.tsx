"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import { useRemoveRunDefinition, useWorkOrder } from "@/lib/hooks";
import type { TestRun, WorkOrderDefinition } from "@/types";
import { AddDefinitionsDialog } from "./add-definitions-dialog";
import { runDefinitionFailure } from "./definition-choices";

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
 * Each route moves ONE member (`POST`/`DELETE
 * /test-runs/{run_id}/definitions`) and answers the whole run, so the panel
 * redraws from the answer. The row's remove calls the second one; the add
 * dialog calls the first once per newly ticked definition. Both are no-ops on
 * a member already there or already gone, so neither checks the set first.
 */
export function DefinitionsPanel({ run }: { run: TestRun }) {
  const ids = run.definition_ids ?? [];
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const removeDefinition = useRemoveRunDefinition(run.run_id);

  // No ids, nothing to resolve: the empty string keeps the query disabled.
  const workOrderQuery = useWorkOrder(ids.length > 0 ? (run.work_order_id ?? "") : "");
  const mirrored = new Map<string, WorkOrderDefinition>(
    (workOrderQuery.data?.definitions ?? []).map((definition) => [definition.td_id, definition]),
  );

  const remove = (tdId: string) => {
    setFailure(null);
    removeDefinition.mutate(tdId, { onError: (error) => setFailure(runDefinitionFailure(error)) });
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
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setFailure(null);
                setAdding(true);
              }}
            >
              Add definitions
            </Button>
          </div>
        }
      />
      {adding && (
        <AddDefinitionsDialog
          runId={run.run_id}
          workOrderId={run.work_order_id ?? ""}
          present={ids}
          onOpenChange={setAdding}
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
            <TableHead>
              <span className="sr-only">Remove</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ids.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="p-0!">
                <EmptyState
                  title="No test definitions on this run"
                  message="Nothing says yet which test cases this run answers. Press Add definitions to assign them."
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
