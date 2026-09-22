"use client";

import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Panel, PanelHead } from "@/components/shared/panel";
import { DefinitionStatusBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useWorkOrder } from "@/lib/hooks";
import type { TestRun, WorkOrderDefinition } from "@/types";

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
 * The test definitions one run covers.
 *
 * `definition_ids` is the run's whole set and the ids alone render without any
 * further read. The titles come from the run's work order, which mirrors one
 * row per definition, so one request resolves every title — and it is the read
 * the work-order screen has usually cached already.
 */
export function DefinitionsPanel({ run }: { run: TestRun }) {
  const ids = run.definition_ids ?? [];
  // No ids, nothing to resolve: the empty string keeps the query disabled.
  const workOrderQuery = useWorkOrder(ids.length > 0 ? (run.work_order_id ?? "") : "");
  const mirrored = new Map<string, WorkOrderDefinition>(
    (workOrderQuery.data?.definitions ?? []).map((definition) => [definition.td_id, definition]),
  );

  return (
    <Panel className="mt-4">
      <PanelHead
        title="Test definitions this run covers"
        action={
          ids.length > 0 && (
            <span className="font-mono text-[0.68rem] text-ink-3">{ids.length} covered</span>
          )
        }
      />
      <Table aria-label="Test definitions this run covers">
        <TableHeader>
          <TableRow>
            <TableHead>Definition</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ids.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={3} className="p-0!">
                <EmptyState
                  title="No test definitions on this run"
                  message="A trace no longer claims the definitions it answers. Today a planning link assigns them — this screen offers no control for it yet."
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
