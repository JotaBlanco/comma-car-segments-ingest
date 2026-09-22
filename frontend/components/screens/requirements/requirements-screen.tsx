"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Archive, Pencil, Plus } from "lucide-react";
import { ActiveFilterPills } from "@/components/shared/active-filter-pills";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/shared/error-state";
import { ExportButton } from "@/components/shared/export-button";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { LoadingRows } from "@/components/shared/loading-rows";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, PanelHead, TableScrollArea } from "@/components/shared/panel";
import { QuickViewSegment, type QuickView } from "@/components/shared/quick-view-segment";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { SourceBadge, type SourceKind } from "@/components/shared/source-badge";
import { ToneBadge } from "@/components/shared/status-badge";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import {
  ToolbarFiltersButton,
  ToolbarRow,
  useDisclosure,
} from "@/components/shared/table-toolbar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirementsApi } from "@/lib/api/requirements";
import { formatArrival } from "@/lib/format";
import { usePlanningSyncStatus, useRequirementFacets, useRequirements } from "@/lib/hooks";
import { useTableState } from "@/lib/table-state";
import type { EarsPattern, RequirementListFilters, VerificationState } from "@/types";
import { AddRequirementDialog } from "./add-requirement-dialog";
import { ChipList, MonoChip } from "./chip-list";
import { EditRequirementDialog } from "./edit-requirement-dialog";
import { RequirementsFiltersPanel } from "./requirements-filters-panel";
import { RequirementsBatchBar } from "./requirements-batch-bar";
import { buildRequirementPills } from "./requirements-active-pills";
import {
  REQUIREMENT_CSV_COLUMNS,
  REQUIREMENTS_TABLE_CONFIG,
} from "./requirements-table-config";
import { RetireRequirementDialog, type RetirableRequirement } from "./retire-requirement-dialog";
import { VerificationChip } from "./verification-chip";

/**
 * Requirements — a widened, fully filterable read+authoring grid over the
 * mirrored `requirements` collection (requirements-page spec + the dispatch
 * brief's override of its "nothing is editable" line, per
 * authoring-controls spec §3).
 */

const PATHNAME = "/requirements";
const COL_COUNT = 17; // checkbox + 15 data columns + actions

function ColHead({
  children,
  source,
  align,
}: {
  children: ReactNode;
  source: SourceKind;
  align?: "right";
}) {
  return (
    <TableHead className={align === "right" ? "text-right!" : undefined}>
      <span className="inline-flex items-center gap-1.5">
        {children}
        <SourceBadge source={source} />
      </span>
    </TableHead>
  );
}

function ChipLink({ href, id }: { href: string; id: string }) {
  return (
    <Link href={href} className="hover:underline">
      <MonoChip>{id}</MonoChip>
    </Link>
  );
}

export function RequirementsScreen() {
  const table = useTableState(REQUIREMENTS_TABLE_CONFIG, PATHNAME);
  const { state, activeQuickViewId } = table;

  const activeOptionCount =
    (state.multi.chapter?.length ?? 0) +
    (state.multi.status?.length ?? 0) +
    (state.multi.state?.length ?? 0) +
    (state.multi.method?.length ?? 0) +
    (state.multi.ears_pattern?.length ?? 0) +
    (state.multi.system_state?.length ?? 0) +
    (state.multi.measurand?.length ?? 0) +
    (state.multi.source?.length ?? 0) +
    (state.single.revision !== undefined ? 1 : 0) +
    (state.single.related_req !== undefined ? 1 : 0) +
    (state.single.has_verified_by !== undefined ? 1 : 0) +
    (state.single.has_latest_run !== undefined ? 1 : 0);
  const disclosure = useDisclosure(activeOptionCount);

  const filters: RequirementListFilters = useMemo(() => {
    const next: RequirementListFilters = { page: state.page, page_size: state.pageSize };
    if ((state.multi.chapter ?? []).length > 0) next.chapter = state.multi.chapter;
    if ((state.multi.status ?? []).length > 0) next.status = state.multi.status;
    if ((state.multi.state ?? []).length > 0) {
      next.state = state.multi.state as readonly VerificationState[];
    }
    if ((state.multi.method ?? []).length > 0) next.method = state.multi.method;
    if ((state.multi.ears_pattern ?? []).length > 0) {
      next.ears_pattern = state.multi.ears_pattern as readonly EarsPattern[];
    }
    if ((state.multi.system_state ?? []).length > 0) next.system_state = state.multi.system_state;
    if ((state.multi.measurand ?? []).length > 0) next.measurand = state.multi.measurand;
    if ((state.multi.source ?? []).length > 0) next.source = state.multi.source;
    if (state.single.revision !== undefined) next.revision = state.single.revision;
    if (state.single.related_req !== undefined) next.related_req = state.single.related_req;
    if (state.single.has_verified_by !== undefined) {
      next.has_verified_by = state.single.has_verified_by === "true";
    }
    if (state.single.has_latest_run !== undefined) {
      next.has_latest_run = state.single.has_latest_run === "true";
    }
    if (state.q.length > 0) next.q = state.q;
    return next;
  }, [state]);

  const { data, isPending, isError, refetch } = useRequirements(filters);
  const { data: facets } = useRequirementFacets();
  const { data: syncStatus } = usePlanningSyncStatus();
  const rows = data?.items ?? [];
  const viewCounts = data?.view_counts;
  const lastSyncAt = syncStatus?.last_sync_at ?? null;

  const quickViews: readonly QuickView[] = [
    { id: "all", label: "All", count: viewCounts?.all },
    { id: "no-evidence", label: "No evidence", count: viewCounts?.no_evidence },
    { id: "failed", label: "Failed", count: viewCounts?.failed },
    { id: "tested", label: "Tested", count: viewCounts?.tested },
  ];

  const pills = useMemo(() => buildRequirementPills(table), [table]);
  const hasActiveFilters = pills.length > 0 || activeQuickViewId !== "all";
  const showEmpty = !isPending && !isError && rows.length === 0 && hasActiveFilters;
  const showBaselineEmpty = !isPending && !isError && rows.length === 0 && !hasActiveFilters;

  /* Selection scoped to the current filter set — the exact shape
     `runs-screen.tsx` uses, so a picked row the filters no longer match
     drops the moment the new rows land. */
  const filterKey = JSON.stringify(filters);
  const [picked, setPicked] = useState<{ key: string; ids: readonly string[] }>({
    key: filterKey,
    ids: [],
  });
  const pickedIds = picked.key === filterKey ? picked.ids : [];
  const setPickedIds = (ids: readonly string[]) => setPicked({ key: filterKey, ids });
  const pickedSet = new Set(pickedIds);
  const pickedRows = rows.filter((row) => pickedSet.has(row.req_id));
  const wholePage = rows.length > 0 && pickedRows.length === rows.length;
  const partPage = pickedRows.length > 0 && !wholePage;
  const togglePick = (reqId: string) =>
    setPickedIds(pickedSet.has(reqId) ? pickedIds.filter((id) => id !== reqId) : [...pickedIds, reqId]);
  const togglePage = () => setPickedIds(wholePage ? [] : rows.map((row) => row.req_id));
  /* The list row carries no `item_version` (the committed API's
     `RequirementRow` does not send one — see the architecture doc). The
     retire dialog fetches each row's current version itself, right before
     retiring it, which is also the more correct concurrency guard: a
     version cached at list-load time could already be stale by the time a
     person clicks Retire. */
  const batchRows: readonly RetirableRequirement[] = pickedRows.map((row) => ({
    req_id: row.req_id,
  }));

  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [retiringRow, setRetiringRow] = useState<RetirableRequirement | null>(null);

  return (
    <FullHeightPage>
      <PageHeader
        title="Requirements"
        sub={
          <span className="text-[0.78rem] text-ink-3">
            <span className="inline-flex items-center gap-1.5">
              <SourceBadge source="api:planning" />
              Status is authored by planning or by a manual row here; Verification is computed
              here from runs and verdicts — the two move independently, so &ldquo;Draft&rdquo;
              beside &ldquo;Tested&rdquo; is legal, not a bug.
            </span>
          </span>
        }
      />

      <ToolbarRow
        actions={
          <>
            <ToolbarFiltersButton disclosure={disclosure} />
            <ExportButton
              total={data?.total ?? 0}
              fetchPage={(page, pageSize) =>
                requirementsApi.list({ ...filters, page, page_size: pageSize })
              }
              columns={REQUIREMENT_CSV_COLUMNS}
              list="requirements"
              scope="requirements"
            />
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-[13px]" strokeWidth={2.2} />
              New requirement
            </Button>
          </>
        }
      >
        <QuickViewSegment
          views={quickViews}
          activeId={activeQuickViewId}
          onSelect={(id) => table.setQuickView(id)}
          aria-label="Requirement quick views"
        />
        <TableSearchInput
          value={state.q}
          onDebouncedChange={(value) => table.setQ(value)}
          placeholder="Filter requirements…"
        />
      </ToolbarRow>

      <RequirementsFiltersPanel
        disclosure={disclosure}
        table={table}
        facets={facets}
        pathname={PATHNAME}
      />

      <div className="mb-2.5" />
      <ActiveFilterPills pills={pills} onClearAll={() => table.clearAll()} />
      <RequirementsBatchBar rows={batchRows} onSelectionChange={setPickedIds} />

      <Panel className="flex min-h-0 flex-1 flex-col">
        <PanelHead
          title="Mirrored requirements"
          action={
            <span className="font-mono text-[0.68rem] text-ink-3">
              synced_at: {lastSyncAt !== null ? formatArrival(lastSyncAt) : "—"}
            </span>
          }
        />
        <TableScrollArea>
          <Table aria-label="Requirements">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={wholePage}
                    indeterminate={partPage}
                    disabled={rows.length === 0}
                    onCheckedChange={togglePage}
                    aria-label="Select every requirement on this page"
                  />
                </TableHead>
                <ColHead source="api:planning">Requirement</ColHead>
                <ColHead source="api:planning">Title</ColHead>
                <ColHead source="api:planning">Chapter</ColHead>
                <ColHead source="api:planning">Status</ColHead>
                <ColHead source="derived">Verification</ColHead>
                <ColHead source="derived">Verified by</ColHead>
                <ColHead source="derived">Latest run</ColHead>
                <ColHead source="derived" align="right">Runs</ColHead>
                <ColHead source="api:planning">Method</ColHead>
                <ColHead source="api:planning">EARS pattern</ColHead>
                <ColHead source="api:planning">System states</ColHead>
                <ColHead source="api:planning">Measurands</ColHead>
                <ColHead source="api:planning">Revision</ColHead>
                <ColHead source="api:planning">Source</ColHead>
                <ColHead source="api:planning">Related reqs</ColHead>
                <TableHead className="w-16">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && <LoadingRows rows={6} cols={COL_COUNT} />}
              {isError && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={COL_COUNT} className="p-0!">
                    <ErrorState onRetry={() => void refetch()} />
                  </TableCell>
                </TableRow>
              )}
              {showBaselineEmpty && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={COL_COUNT} className="p-0!">
                    <span className="grid place-items-center px-4 py-7 text-[0.78rem] text-ink-3">
                      No requirements mirrored yet — planning pushes them through{" "}
                      <span className="font-mono">POST /planning/sync</span>.
                    </span>
                  </TableCell>
                </TableRow>
              )}
              {showEmpty && (
                <TableEmptyState
                  colSpan={COL_COUNT}
                  onClearAll={() => table.clearAll()}
                  message="No requirements match the current filters."
                />
              )}
              {rows.map((row) => (
                <RowLink key={row.req_id} href={`/requirements/${encodeURIComponent(row.req_id)}`}>
                  <TableCell className="w-8" onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      checked={pickedSet.has(row.req_id)}
                      onCheckedChange={() => togglePick(row.req_id)}
                      aria-label={`Select ${row.req_id}`}
                    />
                  </TableCell>
                  <TableCell>
                    <RowLinkLabel>
                      <span className="font-mono text-[0.78rem]">{row.req_id}</span>
                    </RowLinkLabel>
                  </TableCell>
                  <TableCell className="whitespace-normal">{row.title}</TableCell>
                  <TableCell>{row.chapter ?? "—"}</TableCell>
                  <TableCell>
                    <ToneBadge tone="neutral">{row.status}</ToneBadge>
                  </TableCell>
                  <TableCell>
                    <VerificationChip state={row.verification_state} stale={row.evidence_stale} />
                  </TableCell>
                  <TableCell>
                    <ChipList
                      items={row.verified_by}
                      renderItem={(td) => (
                        <ChipLink href={`/definitions/${encodeURIComponent(td)}`} id={td} />
                      )}
                      emptyLabel={<span className="text-ink-3">Not covered</span>}
                    />
                  </TableCell>
                  <TableCell>
                    {row.latest_run_id === null ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <Link
                        href={`/runs/${encodeURIComponent(row.latest_run_id)}`}
                        className="font-mono text-[0.78rem] hover:underline"
                      >
                        {row.latest_run_id}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[0.78rem]">
                    {row.covering_run_count}
                  </TableCell>
                  <TableCell>{row.verification_method ?? "—"}</TableCell>
                  <TableCell>{row.ears_pattern ?? "—"}</TableCell>
                  <TableCell>
                    <ChipList
                      items={row.system_states ?? []}
                      renderItem={(v) => <MonoChip>{v}</MonoChip>}
                    />
                  </TableCell>
                  <TableCell>
                    <ChipList
                      items={row.measurand ?? []}
                      renderItem={(m) => <MonoChip>{`${m.name} (${m.unit})`}</MonoChip>}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-[0.78rem]">{row.revision ?? "—"}</TableCell>
                  <TableCell>
                    <ChipList items={row.source ?? []} renderItem={(v) => <MonoChip>{v}</MonoChip>} />
                  </TableCell>
                  <TableCell>
                    <ChipList
                      items={row.related_reqs ?? []}
                      renderItem={(id) => (
                        <ChipLink href={`/requirements/${encodeURIComponent(id)}`} id={id} />
                      )}
                    />
                  </TableCell>
                  <TableCell className="w-16">
                    <div className="flex items-center justify-end gap-1">
                      {/* The list row carries no per-row origin (the
                          committed API's `RequirementRow` has none — see
                          the architecture doc). Edit always opens; the
                          dialog fetches the full detail and refuses to
                          offer a form for a planning-sourced row once it
                          knows for certain. */}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${row.req_id}`}
                        title="Edit"
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingId(row.req_id);
                        }}
                      >
                        <Pencil />
                      </Button>
                      {/* Retire works on either origin (authoring-controls
                          §3) — it records the decision locally, it never
                          asks planning's permission. */}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Retire ${row.req_id}`}
                        title="Retire"
                        onClick={(event) => {
                          event.stopPropagation();
                          setRetiringRow({ req_id: row.req_id });
                        }}
                      >
                        <Archive />
                      </Button>
                    </div>
                  </TableCell>
                </RowLink>
              ))}
            </TableBody>
          </Table>
        </TableScrollArea>
        {data !== undefined && (
          <TablePager
            page={data.page}
            pageSize={data.page_size}
            total={data.total}
            totalPages={data.total_pages}
            onPageChange={(page) => table.setPage(page)}
            onPageSizeChange={(size) => table.setPageSize(size)}
          />
        )}
      </Panel>

      {addOpen && <AddRequirementDialog open={addOpen} onOpenChange={setAddOpen} />}
      {editingId !== null && (
        <EditRequirementDialog reqId={editingId} onClose={() => setEditingId(null)} />
      )}
      {retiringRow !== null && (
        <RetireRequirementDialog
          open
          onOpenChange={(next) => !next && setRetiringRow(null)}
          rows={[retiringRow]}
          onDone={() => setRetiringRow(null)}
        />
      )}
    </FullHeightPage>
  );
}
