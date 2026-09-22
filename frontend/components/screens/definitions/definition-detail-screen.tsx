"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
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
import { useTestDefinition, useTestDefinitionJournal } from "@/lib/hooks";
import { CustomPropertiesPanel } from "./custom-properties-panel";
import { ImplementationPanel } from "./implementation-panel";
import { RequirementsPanel } from "./requirements-panel";

/**
 * Test definition detail — the node that closed the traceability chain.
 *
 * Every other node of work order -> definition -> run -> file already had a
 * screen. The definition did not, so its id was dead text in three places
 * (FR-DM-074). The screen reuses the work-order detail's layout, badges and
 * breadcrumb, because the two screens read the same read-only mirror.
 *
 * The history panel is the same `EntityHistoryPanel` the file, signal and
 * work-order screens show. The planning mirror journals a definition, so this
 * timeline says who moved a title or a run count, and when. Planning is the
 * only writer, so nobody edits a definition here.
 */

const RUN_COLUMNS = 7;

interface DefinitionDetailScreenProps {
  tdId: string;
}

export function DefinitionDetailScreen({ tdId }: DefinitionDetailScreenProps) {
  const { data: definition, isPending, error, refetch } = useTestDefinition(tdId);
  // The history panel drives the kind filter and the pager through these
  // params, and the journal hook re-queries with them (contract §8b).
  const [journalParams, setJournalParams] = useState<JournalPanelParams>({ page_size: 50 });
  const journalQuery = useTestDefinitionJournal(tdId, journalParams);
  const [noteOpen, setNoteOpen] = useState(false);

  if (error !== null) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <>
        <Crumbs>
          <Crumb type="Def" current>
            {tdId}
          </Crumb>
        </Crumbs>
        <Panel>
          <ErrorState
            message={notFound ? `Test definition ${tdId} not found.` : undefined}
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
          <Crumb type="Def" current>
            {tdId}
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

  const workOrder = definition.work_order;

  return (
    <>
      <Crumbs>
        {workOrder !== null ? (
          <Crumb type="WO" href={`/work-orders/${encodeURIComponent(workOrder.wo_id)}`}>
            {workOrder.wo_id}
          </Crumb>
        ) : (
          <Crumb type="WO" missing>
            {definition.work_order_id ?? "no work order"}
          </Crumb>
        )}
        <Crumb type="Def" current>
          {definition.td_id}
        </Crumb>
      </Crumbs>

      <div className="mb-[18px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-[1.35rem] font-semibold tracking-[-0.01em]">
            {definition.td_id}
          </span>
          <SourceBadge source="api:planning" />
          <DefinitionStatusBadge status={definition.status} />
          {definition.orphaned && (
            <ToneBadge tone="amber" dot>
              Orphaned
            </ToneBadge>
          )}
          <FavouriteStar type="test_definition" id={definition.td_id} label={definition.td_id} />
        </div>
        <div className="mt-[3px] text-[0.8rem] text-ink-3">
          {definition.title} · {definition.actual_runs} of {definition.planned_runs} planned runs
          recorded
        </div>
        {definition.orphaned && (
          <div className="mt-[3px] text-[0.78rem] text-amber">
            {definition.work_order_id === null
              ? "This definition names no work order."
              : `This definition names ${definition.work_order_id}, which this registry does not mirror.`}{" "}
            A person repairs the link on the run, never here.
          </div>
        )}
        <div className="mt-1.5">
          <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-3">
            <Lock size={12} strokeWidth={2} />
            Read-only mirror — owned by the planning system · synced_at{" "}
            {formatArrival(definition.synced_at)}
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
          <MetaCell label="Title">{definition.title}</MetaCell>
          <MetaCell label="Work order" muted={workOrder === null}>
            {workOrder === null ? (
              (definition.work_order_id ?? "—")
            ) : (
              <Link
                href={`/work-orders/${encodeURIComponent(workOrder.wo_id)}`}
                className="font-mono text-[0.78rem] hover:underline"
              >
                {workOrder.wo_id}
              </Link>
            )}
          </MetaCell>
          <MetaCell label="Project" muted={workOrder === null}>
            {workOrder === null ? (
              "—"
            ) : (
              <span className="font-mono text-[0.78rem]">{workOrder.project}</span>
            )}
          </MetaCell>
          <MetaCell label="Status">
            <DefinitionStatusBadge status={definition.status} />
          </MetaCell>
          <MetaCell label="Planned runs">
            <span className="font-mono text-[0.78rem]">{definition.planned_runs}</span>
          </MetaCell>
          <MetaCell label="Actual runs">
            <span className="font-mono text-[0.78rem]">{definition.actual_runs}</span>
          </MetaCell>
          <MetaCell label="Link">
            {definition.orphaned ? (
              <ToneBadge tone="amber" dot>
                Orphaned
              </ToneBadge>
            ) : (
              <ToneBadge tone="green" dot>
                Linked
              </ToneBadge>
            )}
          </MetaCell>
          <MetaCell label="synced_at">
            <span className="font-mono text-[0.74rem]">
              {definition.synced_at.replace("T", " ")}
            </span>
          </MetaCell>
        </MetaGrid>
      </Panel>

      {/* The documents that say what the definition must prove. Planning owns
          a planning document; a person adds and removes a manual one. */}
      <RequirementsPanel
        className="mb-3"
        tdId={definition.td_id}
        files={definition.requirements_files ?? []}
      />

      {/* The `.py` that decides this definition's verdict, named by the sha256
          of its own bytes. */}
      <ImplementationPanel
        className="mb-3"
        tdId={definition.td_id}
        implementation={definition.implementation}
      />

      {/* The pairs a person types. They sit in their own card, never in the
          planning grid above, so nobody reads one as a planning field. */}
      <CustomPropertiesPanel
        className="mb-3"
        tdId={definition.td_id}
        properties={definition.custom_properties ?? {}}
      />

      <Panel className="mb-3">
        <PanelHead
          title="Test runs under this definition"
          action={
            <span className="font-mono text-[0.68rem] text-ink-3">
              {definition.runs.length} recorded · {definition.planned_runs} planned
            </span>
          }
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
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
            {definition.runs.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={RUN_COLUMNS} className="p-0!">
                  <EmptyState message="No runs recorded under this definition yet." />
                </TableCell>
              </TableRow>
            )}
            {definition.runs.map((run) => (
              <RowLink key={run.run_id} href={`/runs/${encodeURIComponent(run.run_id)}`}>
                <TableCell>
                  <RowLinkLabel>
                    <span className="font-mono text-[0.78rem]">{run.run_id}</span>
                  </RowLinkLabel>
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

      <EntityHistoryPanel
        label="definition"
        isPending={journalQuery.isPending}
        isError={journalQuery.isError}
        page={journalQuery.data}
        onRetry={() => void journalQuery.refetch()}
        params={journalParams}
        onParamsChange={setJournalParams}
        action={<AddNoteButton onClick={() => setNoteOpen(true)} />}
      />
      {/* Planning owns every definition field, but a note changes no field:
          it joins the journal beside the mirror entries, under the person's
          own name. Mounted on demand, so a screen nobody writes on asks the
          Portal nothing. */}
      {noteOpen && (
        <AddNoteDialog
          entityType="test_definition"
          entityId={tdId}
          open
          onOpenChange={setNoteOpen}
        />
      )}
    </>
  );
}
