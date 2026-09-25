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
import { DefinitionStatusBadge, StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api/client";
import { formatArrival } from "@/lib/format";
import { useTestDefinition, useTestDefinitionJournal } from "@/lib/hooks";
import { CustomPropertiesPanel } from "./custom-properties-panel";
import { DefinitionVerdictChip } from "./definition-verdict-chip";
import { ImplementationPanel } from "./implementation-panel";
import { RequirementsPanel } from "./requirements-panel";

/**
 * Test definition detail — the node that closed the traceability chain.
 *
 * Every other node of work order -> definition -> run -> file already had a
 * screen. The definition did not, so its id was dead text in three places
 * (FR-DM-074). The screen reuses the work-order detail's layout, badges and
 * breadcrumb, because the two screens carry the same core fields.
 *
 * The history panel is the same `EntityHistoryPanel` the file, signal and
 * work-order screens show. A catalogue push journals a definition, so this
 * timeline says who moved a title or a run count, and when. No route edits
 * those fields, so the panels below carry every control this screen has.
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
          <PanelHead title="Definition metadata" />
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
          <DefinitionStatusBadge status={definition.status} />
          <DefinitionVerdictChip state={definition.verdict_state} />
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
              : `This definition names ${definition.work_order_id}, which this registry does not hold.`}{" "}
            A person repairs the link on the run, never here.
          </div>
        )}
        <div className="mt-1.5">
          <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-3">
            <Lock size={12} strokeWidth={2} />
            Title, work order and run counts arrive with the catalogue and no route moves them;
            requirement files, custom properties and the implementation are edited below.
          </span>
        </div>
      </div>

      <Panel className="mb-3">
        <PanelHead
          title="Definition metadata"
          action={
            <span className="text-[0.7rem] text-ink-3">
              every field arrives with the catalogue or is derived from runs — no route edits either
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
          {/* Plan adherence above, evidence here. The Requirements page draws
              the same pair, for the same reason: the two move independently. */}
          <MetaCell label="Verdict">
            <DefinitionVerdictChip state={definition.verdict_state} />
          </MetaCell>
          <MetaCell label="Last verdict" muted={!definition.latest_verdict}>
            {definition.latest_verdict ? (
              <span className="inline-flex items-center gap-1.5">
                <Link
                  href={`/runs/${encodeURIComponent(definition.latest_verdict.run_id)}`}
                  className="font-mono text-[0.78rem] hover:underline"
                >
                  {definition.latest_verdict.run_id}
                </Link>
                {definition.latest_verdict.produced_at != null && (
                  <span className="text-[0.72rem] text-ink-3">
                    {formatArrival(definition.latest_verdict.produced_at)}
                  </span>
                )}
              </span>
            ) : (
              "—"
            )}
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
          {/* The requirements this definition verifies — the other half of
              the Requirements page's "Verified by" column, read from the
              same authored `covers_req_ids` link (BP5). */}
          {(definition.covers_req_ids ?? []).length > 0 && (
            <MetaCell label="Verifies" className="col-span-4">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {(definition.covers_req_ids ?? []).map((reqId) => (
                  <Link
                    key={reqId}
                    href={`/requirements/${encodeURIComponent(reqId)}`}
                    className="rounded-sm bg-muted px-[5px] py-px font-mono text-[0.7rem] text-ink-2 hover:underline"
                  >
                    {reqId}
                  </Link>
                ))}
              </span>
            </MetaCell>
          )}
        </MetaGrid>
      </Panel>

      {/* The documents that say what the definition must prove. A seeded
          document is read-only; a person adds and removes a manual one. */}
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
          metadata grid above, so nobody reads one as a catalogue field. */}
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
      {/* No route edits a definition field, but a note changes no field: it
          joins the journal beside the catalogue entries, under the person's
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
