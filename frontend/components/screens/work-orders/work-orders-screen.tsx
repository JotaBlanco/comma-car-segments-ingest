"use client";

import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { ActiveFilterPills, type FilterPill } from "@/components/shared/active-filter-pills";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { MultiSelectFilter, type FilterOption } from "@/components/shared/multi-select-filter";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, PanelHead, TableScrollArea } from "@/components/shared/panel";
import { QuickViewSegment, type QuickView } from "@/components/shared/quick-view-segment";
import { SavedSearchButton } from "@/components/shared/saved-search-button";
import { SourceBadge } from "@/components/shared/source-badge";
import { ToneBadge } from "@/components/shared/status-badge";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatArrival } from "@/lib/format";
import { usePlanningSyncStatus, useWorkOrderFacets, useWorkOrders } from "@/lib/hooks";
import { useTableState, type TableStateConfig } from "@/lib/table-state";
import type { WorkOrderListFilters, WorkOrderStatus } from "@/types";
import { AddWorkOrderDialog } from "./add-work-order-dialog";

/**
 * Work orders — LIGHT treatment (spec §0, §4).
 *
 * 42 rows: quick status views + one Project filter + search + pills + pager.
 * NO sortable headers — the endpoint 422s on `sort`/`order` params. Most rows
 * are mirrored from planning; a row opened here reads `manual`, and each row
 * badges the source the API reports rather than an assumed one.
 */

const WO_COLUMNS = 6;

/* The project options come from GET /work-orders/facets over the WHOLE
   mirror. The typed list this replaced never learned a newly mirrored
   project. The facets arrive sorted ascending (contract §10b). */
const projectOptions = (values: readonly string[] | undefined): FilterOption[] =>
  (values ?? []).map((value) => ({
    value,
    label: <span className="font-mono text-[0.78rem]">{value}</span>,
  }));

const WO_TABLE_CONFIG: TableStateConfig = {
  multiKeys: ["status", "project"] as const,
  singleKeys: [] as const,
  // No sort keys — work-orders endpoint rejects `sort`/`order` (contract §1.2).
  sortKeys: [] as const,
  defaultSort: null,
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100, 200, 500] as const,
  quickViews: [
    { id: "all", params: {} },
    { id: "active", params: { status: ["active"] } },
    { id: "closed", params: { status: ["closed"] } },
  ] as const,
};

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

export function WorkOrdersScreen() {
  const table = useTableState(WO_TABLE_CONFIG, "/work-orders");
  const { state, activeQuickViewId } = table;
  const [addOpen, setAddOpen] = useState(false);

  const filters: WorkOrderListFilters = useMemo(() => {
    const next: WorkOrderListFilters = {
      page: state.page,
      page_size: state.pageSize,
    };
    if (state.multi.status.length > 0) {
      next.status = state.multi.status as readonly WorkOrderStatus[];
    }
    if (state.multi.project.length > 0) next.project = state.multi.project;
    if (state.q.length > 0) next.q = state.q;
    return next;
  }, [state]);

  const { data, isPending, isError, refetch } = useWorkOrders(filters);
  const { data: facets } = useWorkOrderFacets();
  const { data: syncStatus } = usePlanningSyncStatus();
  const workOrders = data?.items;
  const viewCounts = data?.view_counts;
  const lastSyncAt = syncStatus?.last_sync_at ?? null;

  const quickViews: readonly QuickView[] = [
    { id: "all", label: "All", count: viewCounts?.all },
    { id: "active", label: "Active", count: viewCounts?.active },
    { id: "closed", label: "Closed", count: viewCounts?.closed },
  ];

  const pills: readonly FilterPill[] = useMemo(() => {
    const list: FilterPill[] = [];
    for (const value of state.multi.status) {
      list.push({
        id: `status:${value}`,
        group: "Status",
        label: value === "active" ? "Active" : "Closed",
        onRemove: () => table.toggleFilterValue("status", value),
      });
    }
    for (const value of state.multi.project) {
      list.push({
        id: `project:${value}`,
        group: "Project",
        label: value,
        onRemove: () => table.toggleFilterValue("project", value),
      });
    }
    if (state.q.length > 0) {
      list.push({
        id: "q",
        group: "Search",
        label: `“${state.q}”`,
        onRemove: () => table.setQ(""),
      });
    }
    return list;
  }, [state, table]);

  const hasActiveFilters =
    state.multi.status.length > 0 || state.multi.project.length > 0 || state.q.length > 0;
  const showEmpty =
    !isPending && !isError && workOrders !== undefined && workOrders.length === 0 && hasActiveFilters;
  const showBaselineEmpty =
    !isPending && !isError && workOrders !== undefined && workOrders.length === 0 && !hasActiveFilters;

  return (
    <FullHeightPage>
      <PageHeader
        title="Work orders"
        sub={
          <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-3">
            <SourceBadge source="api:planning" />
            Mirrored from the planning system — their content is planning&rsquo;s. A campaign
            planning does not know is opened here.
          </span>
        }
      />
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <QuickViewSegment
          views={quickViews}
          activeId={activeQuickViewId}
          onSelect={(id) => table.setQuickView(id)}
          aria-label="Work order quick views"
        />
        <TableSearchInput
          value={state.q}
          onDebouncedChange={(value) => table.setQ(value)}
          placeholder="Filter work orders…"
        />
        <div className="flex-1" />
        <MultiSelectFilter
          label="Project"
          options={projectOptions(facets?.projects)}
          selected={state.multi.project}
          onChange={(next) => table.setFilterValues("project", next)}
        />
        {/* This screen carries no ToolbarPanel, so the button ends the one
            toolbar row, exactly as it ends the panel on the other lists. */}
        <SavedSearchButton
          scope="work-orders"
          pathname="/work-orders"
          query={table.buildQuery(state)}
        />
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-[13px]" strokeWidth={2.2} />
          New work order
        </Button>
      </div>
      <ActiveFilterPills pills={pills} onClearAll={() => table.clearAll()} />
      <Panel className="flex min-h-0 flex-1 flex-col">
        <PanelHead
          title="Work orders"
          action={
            <span className="font-mono text-[0.68rem] text-ink-3">
              synced_at: {lastSyncAt !== null ? formatArrival(lastSyncAt) : "—"}
            </span>
          }
        />
        <TableScrollArea>
          <Table aria-label="Work orders">
          <TableHeader>
            <TableRow>
              <TableHead>Work order</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Project</TableHead>
              <TableHead className="text-right!">Definitions</TableHead>
              <TableHead className="text-right!">Runs</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <LoadingRows rows={4} cols={WO_COLUMNS} />}
            {isError && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={WO_COLUMNS} className="p-0!">
                  <ErrorState onRetry={() => void refetch()} />
                </TableCell>
              </TableRow>
            )}
            {showBaselineEmpty && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={WO_COLUMNS} className="p-0!">
                  <span className="grid place-items-center px-4 py-7 text-[0.78rem] text-ink-3">
                    No work orders mirrored yet.
                  </span>
                </TableCell>
              </TableRow>
            )}
            {showEmpty && (
              <TableEmptyState
                colSpan={WO_COLUMNS}
                onClearAll={() => table.clearAll()}
                message="No work orders match the current filters."
              />
            )}
            {workOrders?.map((workOrder) => (
              <RowLink
                key={workOrder.wo_id}
                href={`/work-orders/${encodeURIComponent(workOrder.wo_id)}`}
              >
                <TableCell>
                  <RowLinkLabel>
                    <span className="font-mono text-[0.78rem]">{workOrder.wo_id}</span>
                  </RowLinkLabel>{" "}
                  <SourceBadge source={workOrder.origin ?? "api:planning"} />
                </TableCell>
                <TableCell className="whitespace-normal">{workOrder.title}</TableCell>
                <TableCell>
                  <span className="font-mono text-[0.78rem]">{workOrder.project}</span>
                </TableCell>
                <TableCell className="text-right font-mono text-[0.78rem]">
                  {workOrder.definition_count}
                </TableCell>
                <TableCell className="text-right font-mono text-[0.78rem]">
                  {workOrder.run_count}
                </TableCell>
                <TableCell>
                  <WorkOrderStatusBadge status={workOrder.status} />
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
      {/* Mounted on demand, the way the requirements screen mounts its own
          add dialog — a shut dialog asks the registry nothing. */}
      {addOpen && <AddWorkOrderDialog open={addOpen} onOpenChange={setAddOpen} />}
    </FullHeightPage>
  );
}
