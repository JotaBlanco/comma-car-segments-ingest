"use client";

import { useMemo, type ReactNode } from "react";
import { ActiveFilterPills } from "@/components/shared/active-filter-pills";
import { ErrorState } from "@/components/shared/error-state";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { LoadingRows } from "@/components/shared/loading-rows";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, PanelHead, TableScrollArea } from "@/components/shared/panel";
import { RowLink } from "@/components/shared/row-link";
import { SourceBadge, type SourceKind } from "@/components/shared/source-badge";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import { ToolbarRow } from "@/components/shared/table-toolbar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTestDefinitionFacets, useTestDefinitions } from "@/lib/hooks";
import { useTableState } from "@/lib/table-state";
import type { DefinitionStatus, TestDefinitionListFilters } from "@/types";
import { buildDefinitionPills } from "./definitions-active-pills";
import { useHiddenColumns } from "./definitions-column-visibility";
import { DEFINITION_COLUMNS } from "./definitions-columns";
import { DefinitionsColumnsMenu } from "./definitions-columns-menu";
import { DefinitionsFiltersPopover } from "./definitions-filters-popover";
import { DEFINITIONS_TABLE_CONFIG } from "./definitions-table-config";

/**
 * Test definitions — the catalogue's definitions, filtered. No route edits
 * their core fields, so this screen only reads and narrows.
 *
 * Every filter lives in the URL (`@/lib/table-state`), so a narrowed view is a
 * link a colleague can open and a reload keeps. The Home panel's
 * `?orphaned=true` is one such link and needs no special case here.
 *
 * The data columns are declared once in `definitions-columns.tsx`, and both
 * the header and the body map the visible slice of that list, so a column
 * hidden from the Columns menu leaves the table whole.
 */

const PATHNAME = "/definitions";

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

export function DefinitionsScreen() {
  const table = useTableState(DEFINITIONS_TABLE_CONFIG, PATHNAME);
  const { state } = table;

  const activeOptionCount =
    (state.multi.work_order?.length ?? 0) +
    (state.multi.status?.length ?? 0) +
    (state.multi.requirement?.length ?? 0) +
    (state.single.orphaned !== undefined ? 1 : 0);

  const hiddenColumns = useHiddenColumns();
  const columns = useMemo(() => {
    const hidden = new Set(hiddenColumns);
    return DEFINITION_COLUMNS.filter((column) => column.pinned === true || !hidden.has(column.id));
  }, [hiddenColumns]);
  /* This table carries no checkbox and no actions cell, so the visible data
     columns are exactly what a loading, error or empty row spans. */
  const colCount = columns.length;

  const filters: TestDefinitionListFilters = useMemo(() => {
    const next: TestDefinitionListFilters = { page: state.page, page_size: state.pageSize };
    if ((state.multi.work_order ?? []).length > 0) next.work_order = state.multi.work_order;
    if ((state.multi.status ?? []).length > 0) {
      next.status = state.multi.status as readonly DefinitionStatus[];
    }
    if ((state.multi.requirement ?? []).length > 0) next.requirement = state.multi.requirement;
    if (state.single.orphaned !== undefined) next.orphaned = state.single.orphaned === "true";
    if (state.q.length > 0) next.q = state.q;
    return next;
  }, [state]);

  const { data, isPending, isError, refetch } = useTestDefinitions(filters);
  const { data: facets } = useTestDefinitionFacets();
  const rows = data?.items ?? [];

  const pills = useMemo(() => buildDefinitionPills(table), [table]);
  const showEmpty = !isPending && !isError && rows.length === 0 && pills.length > 0;
  const showBaselineEmpty = !isPending && !isError && rows.length === 0 && pills.length === 0;

  return (
    <FullHeightPage>
      <PageHeader
        title="Test definitions"
        sub={
          <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-3">
            <SourceBadge source="api:planning" />
            Definitions arrive with the catalogue — an orphan names a work order this registry
            does not hold. Status is plan adherence; Verdict is what the runs decided, so
            &ldquo;On plan&rdquo; beside &ldquo;Failed&rdquo; is legal, not a bug.
          </span>
        }
      />

      <ToolbarRow
        actions={
          <>
            <DefinitionsFiltersPopover
              table={table}
              facets={facets}
              activeCount={activeOptionCount}
            />
            <DefinitionsColumnsMenu hidden={hiddenColumns} />
          </>
        }
      >
        <TableSearchInput
          value={state.q}
          onDebouncedChange={(value) => table.setQ(value)}
          placeholder="Filter definitions…"
        />
      </ToolbarRow>

      <div className="mb-2.5" />
      <ActiveFilterPills pills={pills} onClearAll={() => table.clearAll()} />

      <Panel className="flex min-h-0 flex-1 flex-col">
        <PanelHead
          title={state.single.orphaned === "true" ? "Orphaned definitions" : "Mirrored definitions"}
        />
        <TableScrollArea>
          <Table aria-label="Test definitions">
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <ColHead key={column.id} source={column.source} align={column.align}>
                    {column.label}
                  </ColHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && <LoadingRows rows={4} cols={colCount} />}
              {isError && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={colCount} className="p-0!">
                    <ErrorState onRetry={() => void refetch()} />
                  </TableCell>
                </TableRow>
              )}
              {showBaselineEmpty && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={colCount} className="p-0!">
                    <span className="grid place-items-center px-4 py-7 text-[0.78rem] text-ink-3">
                      No test definitions mirrored yet.
                    </span>
                  </TableCell>
                </TableRow>
              )}
              {showEmpty && (
                <TableEmptyState
                  colSpan={colCount}
                  onClearAll={() => table.clearAll()}
                  message="No test definitions match the current filters."
                />
              )}
              {rows.map((row) => (
                <RowLink key={row.td_id} href={`/definitions/${encodeURIComponent(row.td_id)}`}>
                  {columns.map((column) => (
                    <TableCell key={column.id} className={column.cellClassName}>
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </RowLink>
              ))}
            </TableBody>
          </Table>
        </TableScrollArea>
        {/* Wired the way the files screen wires its pager: the numbers come
            from the response envelope, never from the request state. */}
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
    </FullHeightPage>
  );
}
