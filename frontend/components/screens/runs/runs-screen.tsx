"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ActiveFilterPills, type FilterPill } from "@/components/shared/active-filter-pills";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { ExportButton } from "@/components/shared/export-button";
import { SavedSearchButton } from "@/components/shared/saved-search-button";
import { MultiSelectFilter, type FilterOption } from "@/components/shared/multi-select-filter";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, TableScrollArea } from "@/components/shared/panel";
import { QuickViewSegment, type QuickView } from "@/components/shared/quick-view-segment";
import {
  ToolbarDivider,
  ToolbarFiltersButton,
  ToolbarGroupLabel,
  ToolbarPanel,
  ToolbarRow,
  useDisclosure,
} from "@/components/shared/table-toolbar";
import { SortableTh } from "@/components/shared/sortable-th";
import { WorkbookMenu } from "@/components/shared/workbook-menu";
import { StatusBadge } from "@/components/shared/status-badge";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runsApi } from "@/lib/api/runs";
import { formatArrival } from "@/lib/format";
import { useRunFacets, useRuns } from "@/lib/hooks";
import { useTableState, type TableStateConfig } from "@/lib/table-state";
import type { CsvColumn } from "@/lib/table-csv";
import type {
  RunGroupBy,
  RunListFilters,
  RunSortKey,
  RunStatus,
  SortOrder,
  SourceTag,
  TestRunListItem,
} from "@/types";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { RunGroupBySelect, RunGroupsPanel, runGroupLabel } from "./run-groups";
import { RunsBatchBar } from "./runs-batch-bar";

/* --------------------------------------------------------------------------
 * Config — quick views (strict set-equality presets, spec §3), filter options,
 * sortable-key whitelist. Kept module-level so identity is stable across
 * renders (the `useTableState` hook memoises on `config`).
 * -------------------------------------------------------------------------- */

const RUN_STATUS_OPTIONS: readonly FilterOption[] = [
  { value: "complete", label: <StatusBadge status="complete" /> },
  { value: "awaiting_work_order", label: <StatusBadge status="awaiting_work_order" /> },
  { value: "invalid", label: <StatusBadge status="invalid" /> },
];

/* The rig and the project options come from the facets the API serves, never
   from a typed list. A typed list missed RIG-01 and EX30, so the filter could
   not select the runs that arrive today. The facets arrive sorted ascending
   (contract §2b), so no client-side sort is needed. */
const monoOptions = (values: readonly string[] | undefined): FilterOption[] =>
  (values ?? []).map((value) => ({
    value,
    label: <span className="font-mono text-[0.78rem]">{value}</span>,
  }));

const RUNS_TABLE_CONFIG: TableStateConfig = {
  // `source` joins the repeated-param keys (TR-011). The Home card links
  // straight into it, so the key must survive the URL round trip.
  multiKeys: ["status", "rig", "project", "source"],
  // `group_by` rides the same URL state as every other filter (FR-DM-108), so
  // a grouped view is shareable, back-button friendly and savable like the rest.
  singleKeys: ["signal", "definition", "work_order", "group_by"],
  sortKeys: ["first_data_at"],
  defaultSort: { key: "first_data_at", order: "desc" },
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100, 200, 500],
  quickViews: [
    { id: "all", params: {} },
    { id: "attention", params: { status: ["awaiting_work_order", "invalid"] } },
    { id: "invalid", params: { status: ["invalid"] } },
  ],
};

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  complete: "Linked",
  awaiting_work_order: "Awaiting work order",
  invalid: "Invalid",
};

const COL_COUNT = 10;

/* The CSV carries the stored value of each column, never the screen glyph:
   the raw timestamp, and an empty field where the screen prints a dash. */
const RUN_CSV_COLUMNS: readonly CsvColumn<TestRunListItem>[] = [
  { header: "Run", value: (run) => run.run_id },
  { header: "Description", value: (run) => run.description },
  { header: "Definition", value: (run) => run.definition_id },
  { header: "Work order", value: (run) => run.work_order_id },
  { header: "Project", value: (run) => run.project },
  { header: "Rig", value: (run) => run.rig_id },
  { header: "Test cell", value: (run) => run.test_cell },
  { header: "Files", value: (run) => run.file_count, type: "number" },
  { header: "Signals", value: (run) => run.signal_count, type: "number" },
  { header: "Arrived", value: (run) => run.first_data_at, type: "date" },
  { header: "Status", value: (run) => run.status },
  { header: "Invalid", value: (run) => (run.invalid.flagged ? "yes" : "no") },
  { header: "Invalid reason", value: (run) => run.invalid.reason },
];

export function RunsScreen() {
  const table = useTableState(RUNS_TABLE_CONFIG, "/runs");
  const { state, activeQuickViewId } = table;
  /* How many panel controls are doing something. It rides on the button as a
     count, so a shut panel still says how much is on. */
  const activeOptionCount =
    (state.multi.status?.length ?? 0) +
    (state.multi.rig?.length ?? 0) +
    (state.multi.project?.length ?? 0) +
    (state.single.group_by === undefined ? 0 : 1);

  const disclosure = useDisclosure(activeOptionCount);

  const filters = useMemo<RunListFilters>(() => {
    const next: RunListFilters = {
      page: state.page,
      page_size: state.pageSize,
    };
    const status = state.multi.status as readonly RunStatus[] | undefined;
    if (status && status.length > 0) next.status = status;
    if (state.multi.rig && state.multi.rig.length > 0) next.rig = state.multi.rig;
    if (state.multi.project && state.multi.project.length > 0) next.project = state.multi.project;
    const source = state.multi.source as readonly SourceTag[] | undefined;
    if (source && source.length > 0) next.source = source;
    if (state.single.signal !== undefined) next.signal = state.single.signal;
    if (state.single.definition !== undefined) next.definition = state.single.definition;
    if (state.single.work_order !== undefined) next.work_order = state.single.work_order;
    if (state.q.length > 0) next.q = state.q;
    if (state.sort !== null) {
      next.sort = state.sort.key as RunSortKey;
      next.order = state.sort.order as SortOrder;
    }
    return next;
  }, [state]);

  const groupBy = state.single.group_by as RunGroupBy | undefined;

  /* The list query stays on while a group is selected. The quick-view counts,
     the CSV export and the pills all read it, and the two answers share one
     filters object — which is what makes them agree. */
  const { data, isPending, isError, refetch } = useRuns(filters);
  const runs = data?.items;
  const viewCounts = data?.view_counts;
  /* GET /test-runs/facets feeds the filter options over the WHOLE table. The
     filtered list cannot do it: after a rig selection it holds that rig only,
     and the user could then never add a second rig. The newest-200 page it
     replaced dropped any rig idle for 200 runs. */
  const facets = useRunFacets().data;
  const rigOptions = useMemo(() => monoOptions(facets?.rigs), [facets]);
  const projectOptions = useMemo(() => monoOptions(facets?.projects), [facets]);

  const quickViews: readonly QuickView[] = useMemo(
    () => [
      { id: "all", label: "All", count: viewCounts?.all },
      { id: "attention", label: "Needs attention", count: viewCounts?.attention },
      { id: "invalid", label: "Invalid", count: viewCounts?.invalid },
    ],
    [viewCounts]
  );

  const pills = useMemo<readonly FilterPill[]>(() => {
    const list: FilterPill[] = [];
    for (const value of state.multi.status ?? []) {
      list.push({
        id: `status:${value}`,
        group: "Status",
        label: RUN_STATUS_LABELS[value as RunStatus] ?? value,
        onRemove: () => table.toggleFilterValue("status", value),
      });
    }
    for (const value of state.multi.rig ?? []) {
      list.push({
        id: `rig:${value}`,
        group: "Rig",
        label: value,
        onRemove: () => table.toggleFilterValue("rig", value),
      });
    }
    for (const value of state.multi.project ?? []) {
      list.push({
        id: `project:${value}`,
        group: "Project",
        label: value,
        onRemove: () => table.toggleFilterValue("project", value),
      });
    }
    for (const value of state.multi.source ?? []) {
      list.push({
        id: `source:${value}`,
        group: "Source",
        label: value,
        onRemove: () => table.toggleFilterValue("source", value),
      });
    }
    if (state.single.signal !== undefined) {
      list.push({
        id: "signal",
        group: "Signal",
        label: state.single.signal,
        onRemove: () => table.setFilterValues("signal", []),
      });
    }
    if (state.single.definition !== undefined) {
      list.push({
        id: "definition",
        group: "Definition",
        label: state.single.definition,
        onRemove: () => table.setFilterValues("definition", []),
      });
    }
    if (state.single.work_order !== undefined) {
      list.push({
        id: "work_order",
        group: "Work order",
        label: state.single.work_order,
        onRemove: () => table.setFilterValues("work_order", []),
      });
    }
    if (state.single.group_by !== undefined) {
      list.push({
        id: "group_by",
        group: "Group by",
        label: runGroupLabel(state.single.group_by as RunGroupBy),
        onRemove: () => table.setFilterValues("group_by", []),
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

  const total = data?.total ?? 0;
  const totalPages = data?.total_pages ?? 1;
  const hasActiveFilters = pills.length > 0 || activeQuickViewId !== "all";

  /* Row selection — the same shape `files/files-screen.tsx` uses, and for the
     same reason: the header box covers THIS PAGE, a row box covers its row,
     and the selection carries the filter state and the page it belongs to. A
     change to either gives a new key, so the old pick drops in the same render
     that draws the new rows. The bar reads the ids on screen, never the raw
     state, so a run the table no longer shows can never take a delete. */
  const filterKey = JSON.stringify(filters);
  const [picked, setPicked] = useState<{ key: string; ids: readonly string[] }>({
    key: filterKey,
    ids: [],
  });
  const pickedIds = picked.key === filterKey ? picked.ids : [];
  const setPickedIds = (ids: readonly string[]) => setPicked({ key: filterKey, ids });

  const rows = runs ?? [];
  const pickedSet = new Set(pickedIds);
  const pickedRows = rows.filter((run) => pickedSet.has(run.run_id));
  const wholePage = rows.length > 0 && pickedRows.length === rows.length;
  const partPage = pickedRows.length > 0 && !wholePage;

  const togglePick = (runId: string) => {
    setPickedIds(
      pickedSet.has(runId) ? pickedIds.filter((id) => id !== runId) : [...pickedIds, runId],
    );
  };

  const togglePage = () => {
    setPickedIds(wholePage ? [] : rows.map((run) => run.run_id));
  };

  return (
    <FullHeightPage>
      <PageHeader
        title="Test runs"
        sub="Runs appear automatically when data arrives from a rig. Nothing here is created by hand."
      />

      {/* Two tiers.
          The always-on row carries the four things a person touches on nearly
          every visit: which subset, free text, the way in to the rest, and
          the export. Everything else lives one click away in the panel below.
          Collapsing is safe because `ActiveFilterPills` sits under this and
          keeps naming every filter that is on, whether the panel is open or
          shut — so a shut panel never hides state. */}
      <ToolbarRow
        actions={
          <>
            <ToolbarFiltersButton disclosure={disclosure} />
            <ExportButton
              total={data?.total ?? 0}
              fetchPage={(page, pageSize) =>
                runsApi.list({ ...filters, page, page_size: pageSize })
              }
              columns={RUN_CSV_COLUMNS}
              list="test runs"
              scope="runs"
              /* The server-side export (FR-DM-043). It takes the same filters
                 object the list call takes, so the file holds the rows the
                 table shows — every one of them, not the pages the browser
                 loop walked. */
              serverExport={{ path: "/test-runs/export", params: filters }}
            />
          </>
        }
      >
        <QuickViewSegment
          views={quickViews}
          activeId={activeQuickViewId}
          onSelect={table.setQuickView}
          aria-label="Run quick views"
        />
        <ToolbarDivider />
        <TableSearchInput
          value={state.q}
          onDebouncedChange={table.setQ}
          placeholder="Filter test runs…"
        />
      </ToolbarRow>

      {/* Two named groups and one saved-search control, so nothing here reads
          as thrown in: FILTER narrows the rows, VIEW changes how they are
          shown, and the saved search is the whole set of both kept for next
          time — which is why it sits at the end and not loose in the row.
          No column picker: it changes the FILE an export writes and never the
          table (the table shows 8 columns, the file carries 13, and the
          table's "Rig / Cell" is two columns in the file), so it lives in the
          Export menu where what it governs is unmistakable. */}
      <ToolbarPanel disclosure={disclosure}>
        <ToolbarGroupLabel>Filter</ToolbarGroupLabel>
        <MultiSelectFilter
          label="Status"
          options={RUN_STATUS_OPTIONS}
          selected={state.multi.status ?? []}
          onChange={(next) => table.setFilterValues("status", next)}
        />
        <MultiSelectFilter
          label="Rig"
          options={rigOptions}
          selected={state.multi.rig ?? []}
          onChange={(next) => table.setFilterValues("rig", next)}
        />
        <MultiSelectFilter
          label="Project"
          options={projectOptions}
          selected={state.multi.project ?? []}
          onChange={(next) => table.setFilterValues("project", next)}
        />

        <ToolbarDivider />

        <ToolbarGroupLabel>View</ToolbarGroupLabel>
        {/* The custom keys come from the whole-table facets, so a person picks
            a criterion of their own instead of typing one (FR-DM-108). */}
        <RunGroupBySelect
          value={groupBy}
          customKeys={facets?.custom_property_keys}
          onChange={(next) => table.setFilterValues("group_by", next ? [next] : [])}
        />

        <div className="ml-auto">
          <SavedSearchButton scope="runs" pathname="/runs" query={table.buildQuery(state)} />
        </div>
      </ToolbarPanel>

      <div className="mb-2.5" />

      <ActiveFilterPills pills={pills} onClearAll={table.clearAll} />

      {/* The bar renders nothing while nothing is picked, so a person who never
          ticks a box sees the screen it always was. */}
      {groupBy === undefined && (
        <RunsBatchBar runIds={pickedRows.map((run) => run.run_id)} onSelectionChange={setPickedIds} />
      )}

      {groupBy !== undefined ? (
        <RunGroupsPanel
          groupBy={groupBy}
          filters={filters}
          onPageChange={table.setPage}
          onPageSizeChange={table.setPageSize}
        />
      ) : (
      <Panel className="flex min-h-0 flex-1 flex-col">
        <TableScrollArea>
          <Table aria-label="Test runs">
            <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={wholePage}
                  indeterminate={partPage}
                  disabled={rows.length === 0}
                  onCheckedChange={togglePage}
                  aria-label="Select every run on this page"
                />
              </TableHead>
              {/* NOT sortable. GET /test-runs whitelists exactly one sort key
                  (`first_data_at` — api/api/routers/test_runs.py), so this
                  header used to carry the SAME key as "Arrived": two columns
                  answered aria-sort at once, and "sorting by Run" was a lie a
                  screen reader repeated (FR-DM-091). A run-id sort needs an
                  API key first. */}
              <TableHead>Run</TableHead>
              <TableHead>Definition</TableHead>
              <TableHead>Work order</TableHead>
              <TableHead>Rig / Cell</TableHead>
              <TableHead className="text-right!">Files</TableHead>
              <TableHead className="text-right!">Signals</TableHead>
              <SortableTh
                label="Arrived"
                sortKey="first_data_at"
                active={state.sort}
                onSort={(key) => table.setSort(key, "desc")}
              />
              <TableHead>Status</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Open in</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <LoadingRows rows={8} cols={COL_COUNT} />}
            {isError && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COL_COUNT} className="p-0!">
                  <ErrorState onRetry={() => void refetch()} />
                </TableCell>
              </TableRow>
            )}
            {runs !== undefined && runs.length === 0 && hasActiveFilters && (
              <TableEmptyState colSpan={COL_COUNT} onClearAll={table.clearAll} />
            )}
            {runs !== undefined && runs.length === 0 && !hasActiveFilters && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COL_COUNT} className="px-4 py-7 text-center text-[0.78rem] text-ink-3">
                  No runs yet.
                </TableCell>
              </TableRow>
            )}
            {runs?.map((run) => (
              <RowLink key={run.run_id} href={`/runs/${encodeURIComponent(run.run_id)}`}>
                {/* The row click opens the run, so the box stops the event.
                    Ticking a box must never navigate away from the table. */}
                <TableCell className="w-8" onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={pickedSet.has(run.run_id)}
                    onCheckedChange={() => togglePick(run.run_id)}
                    aria-label={`Select ${run.run_id}`}
                  />
                </TableCell>
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
                  {run.work_order_id ? (
                    <Link
                      href={`/work-orders/${encodeURIComponent(run.work_order_id)}`}
                      className="font-mono text-[0.78rem] hover:underline"
                    >
                      {run.work_order_id}
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
                <TableCell className="text-right font-mono text-[0.78rem]">
                  {run.file_count}
                </TableCell>
                <TableCell className="text-right font-mono text-[0.78rem]">
                  {run.signal_count}
                </TableCell>
                <TableCell>{formatArrival(run.first_data_at)}</TableCell>
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
        </TableScrollArea>
        {data !== undefined && (
          <TablePager
            page={data.page}
            pageSize={data.page_size}
            total={total}
            totalPages={totalPages}
            onPageChange={table.setPage}
            onPageSizeChange={table.setPageSize}
          />
        )}
      </Panel>
      )}
    </FullHeightPage>
  );
}
