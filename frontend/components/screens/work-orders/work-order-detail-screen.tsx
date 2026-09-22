"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AddNoteButton, AddNoteDialog } from "@/components/shared/add-note-dialog";
import { WorkbookMenu } from "@/components/shared/workbook-menu";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { Crumb, Crumbs } from "@/components/shared/crumbs";
import { EmptyState } from "@/components/shared/empty-state";
import {
  EntityHistoryPanel,
  type JournalPanelParams,
} from "@/components/shared/entity-history-panel";
import { ErrorState } from "@/components/shared/error-state";
import { FavouriteStar } from "@/components/shared/favourite-star";
import { LoadingRows } from "@/components/shared/loading-rows";
import { MetaCell, MetaGrid } from "@/components/shared/meta-grid";
import { Panel, PanelHead } from "@/components/shared/panel";
import { SourceBadge } from "@/components/shared/source-badge";
import { DefinitionStatusBadge, StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api/client";
import { formatArrival } from "@/lib/format";
import { usePageTitle, useRuns, useWorkOrder, useWorkOrderJournal } from "@/lib/hooks";
import type { WorkOrderStatus } from "@/types";

function WorkOrderStatusBadge({ status }: { status: WorkOrderStatus }) {
  if (status === "active") {
    return (
      <ToneBadge tone="green" dot>
        Active
      </ToneBadge>
    );
  }
  return <ToneBadge tone="neutral">Closed</ToneBadge>;
}

interface WorkOrderDetailScreenProps {
  woId: string;
}

export function WorkOrderDetailScreen({ woId }: WorkOrderDetailScreenProps) {
  const { data: workOrder, isPending, error, refetch } = useWorkOrder(woId);
  /* The window title names the work order the moment it loads (FR-DM-091). */
  usePageTitle(workOrder ? `${workOrder.wo_id} — work order` : null);
  const runsQuery = useRuns({ work_order: woId, page_size: 50 });
  // The history panel drives the kind filter and the pager through these
  // params, and the journal hook re-queries with them (contract §8b).
  const [journalParams, setJournalParams] = useState<JournalPanelParams>({ page_size: 50 });
  const journalQuery = useWorkOrderJournal(woId, journalParams);
  const [noteOpen, setNoteOpen] = useState(false);
  const runs = runsQuery.data?.items;

  if (error !== null) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <>
        <Crumbs>
          <Crumb type="WO" current>
            {woId}
          </Crumb>
        </Crumbs>
        <Panel>
          <ErrorState
            message={notFound ? `Work order ${woId} not found.` : undefined}
            onRetry={notFound ? undefined : () => void refetch()}
          />
        </Panel>
      </>
    );
  }

  if (isPending) {
    return (
      <>
        <Crumbs>
          <Crumb type="WO" current>
            {woId}
          </Crumb>
        </Crumbs>
        <div className="mb-[18px] space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Panel>
          <PanelHead title="Planning metadata" />
          <Table>
            <TableBody>
              <LoadingRows rows={4} cols={4} />
            </TableBody>
          </Table>
        </Panel>
      </>
    );
  }

  return (
    <>
      <Crumbs>
        <Crumb type="WO" current>
          {workOrder.wo_id}
        </Crumb>
      </Crumbs>

      <div className="mb-[18px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-mono text-[1.35rem] font-semibold tracking-[-0.01em]">
            {workOrder.wo_id}
          </h1>
          <SourceBadge source="api:planning" />
          <WorkOrderStatusBadge status={workOrder.status} />
          <FavouriteStar type="work_order" id={workOrder.wo_id} label={workOrder.wo_id} />
        </div>
        <div className="mt-[3px] text-[0.8rem] text-ink-3">
          {workOrder.title} · project{" "}
          <span className="font-mono text-[0.78rem]">{workOrder.project}</span>
        </div>
        <div className="mt-1.5">
          <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-3">
            <Lock size={12} strokeWidth={2} />
            Read-only mirror — owned by the planning system · synced_at{" "}
            {formatArrival(workOrder.synced_at)}
          </span>
        </div>
      </div>

      <Panel className="mb-3">
        <PanelHead
          title="Planning metadata"
          action={
            <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-3">
              all fields <SourceBadge source="api:planning" /> — never editable here
            </span>
          }
        />
        <MetaGrid>
          <MetaCell label="Title">{workOrder.title}</MetaCell>
          <MetaCell label="Project">
            <span className="font-mono text-[0.78rem]">{workOrder.project}</span>
          </MetaCell>
          <MetaCell label="Requestor" muted={!workOrder.requestor}>
            {workOrder.requestor ?? "—"}
          </MetaCell>
          <MetaCell label="Status">
            <WorkOrderStatusBadge status={workOrder.status} />
          </MetaCell>
          <MetaCell label="Created" muted={!workOrder.created_at_source}>
            {workOrder.created_at_source?.slice(0, 10) ?? "—"}
          </MetaCell>
          <MetaCell label="Department" muted={!workOrder.department}>
            {workOrder.department ?? "—"}
          </MetaCell>
          <MetaCell label="Priority" muted={!workOrder.priority}>
            {workOrder.priority ?? "—"}
          </MetaCell>
          <MetaCell label="synced_at">
            <span className="font-mono text-[0.74rem]">
              {workOrder.synced_at.replace("T", " ")}
            </span>
          </MetaCell>
        </MetaGrid>
      </Panel>

      <Panel className="mb-3">
        <PanelHead
          title="Test runs under this work order"
          action={
            <Link href="/runs" className="text-[0.75rem] font-semibold text-primary">
              All runs
            </Link>
          }
        />
        <Table aria-label="Test runs under this work order">
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Definition</TableHead>
              <TableHead>Rig</TableHead>
              <TableHead>Arrived</TableHead>
              <TableHead className="text-right!">Files</TableHead>
              <TableHead className="text-right!">Signals</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Open in</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runsQuery.isPending && <LoadingRows rows={2} cols={7} />}
            {runsQuery.isError && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-0!">
                  <ErrorState onRetry={() => void runsQuery.refetch()} />
                </TableCell>
              </TableRow>
            )}
            {runs !== undefined && runs.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-0!">
                  <EmptyState message="No runs recorded under this work order yet." />
                </TableCell>
              </TableRow>
            )}
            {runs?.map((run) => (
              <RowLink key={run.run_id} href={`/runs/${encodeURIComponent(run.run_id)}`}>
                <TableCell>
                  <RowLinkLabel>
                    <span className="font-mono text-[0.78rem]">{run.run_id}</span>
                  </RowLinkLabel>
                  <div className="mt-px text-[0.72rem] text-ink-3">{run.description ?? "—"}</div>
                </TableCell>
                <TableCell>
                  {run.definition_id ? (
                    <Link
                      href={`/definitions/${encodeURIComponent(run.definition_id)}`}
                      className="font-mono text-[0.78rem] hover:underline"
                    >
                      {run.definition_id}
                    </Link>
                  ) : (
                    <span className="font-mono text-[0.78rem]">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-[0.78rem]">
                    {run.rig_id} / {run.test_cell ?? "—"}
                  </span>
                </TableCell>
                <TableCell>{formatArrival(run.first_data_at)}</TableCell>
                <TableCell className="text-right font-mono text-[0.78rem]">
                  {run.file_count}
                </TableCell>
                <TableCell className="text-right font-mono text-[0.78rem]">
                  {run.signal_count}
                </TableCell>
                <TableCell>
                  <StatusBadge status={run.status} />
                </TableCell>
                <TableCell className="w-10 text-right">
                  <WorkbookMenu run={run.run_id} explore={{ run: run.run_id }} iconOnly />
                </TableCell>
              </RowLink>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <Panel className="mb-3">
        <PanelHead
          title="Test definitions in this work order"
          action={
            <span className="font-mono text-[0.68rem] text-ink-3">
              {workOrder.definitions.length} mirrored
            </span>
          }
        />
        <Table aria-label="Test definitions of this work order">
          <TableHeader>
            <TableRow>
              <TableHead>Definition</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="text-right!">Planned runs</TableHead>
              <TableHead className="text-right!">Actual runs</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Open in</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workOrder.definitions.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0!">
                  <EmptyState message="No definitions mirrored for this work order." />
                </TableCell>
              </TableRow>
            )}
            {workOrder.definitions.map((definition) => (
              <TableRow key={definition.td_id} className="hover:bg-transparent">
                <TableCell>
                  <Link
                    href={`/definitions/${encodeURIComponent(definition.td_id)}`}
                    className="font-mono text-[0.78rem] text-primary hover:underline"
                  >
                    {definition.td_id}
                  </Link>{" "}
                  <SourceBadge source="api:planning" />
                </TableCell>
                <TableCell className="whitespace-normal">{definition.title}</TableCell>
                <TableCell className="text-right font-mono text-[0.78rem]">
                  {definition.planned_runs}
                </TableCell>
                <TableCell className="text-right font-mono text-[0.78rem]">
                  {definition.actual_runs}
                </TableCell>
                <TableCell>
                  <DefinitionStatusBadge status={definition.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <EntityHistoryPanel
        label="work order"
        isPending={journalQuery.isPending}
        isError={journalQuery.isError}
        page={journalQuery.data}
        onRetry={() => void journalQuery.refetch()}
        params={journalParams}
        onParamsChange={setJournalParams}
        action={<AddNoteButton onClick={() => setNoteOpen(true)} />}
      />
      {/* The mirror is read-only, but a note changes no field: it joins the
          journal beside the planning entries, under the person's own name.
          Mounted on demand, so a screen nobody writes on asks the Portal
          nothing. */}
      {noteOpen && (
        <AddNoteDialog entityType="work_order" entityId={woId} open onOpenChange={setNoteOpen} />
      )}
    </>
  );
}
