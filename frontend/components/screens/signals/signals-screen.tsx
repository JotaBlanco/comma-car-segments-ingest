"use client";

import { useMemo } from "react";
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
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { SortableTh } from "@/components/shared/sortable-th";
import { SourceBadge } from "@/components/shared/source-badge";
import { ToneBadge } from "@/components/shared/status-badge";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import { signalsApi } from "@/lib/api/signals";
import { useSignalFacets, useSignals } from "@/lib/hooks";
import { useTableState, type TableStateConfig } from "@/lib/table-state";
import type { CsvColumn } from "@/lib/table-csv";
import {
  sourceMeaning,
  type SignalCatalogEntry,
  type SignalListFilters,
  type SignalSortKey,
  type SourceTag,
} from "@/types";
import { baseDtype, formatDay } from "./format";

/**
 * Signals screen — full treatment, pagination-first (6,412 cataloged signals).
 *
 * URL state is owned by `useTableState`; multi-select filters use repeated query params
 * (`unit`, `rate`, `rig`, `dtype`, `source_system`, `source`). `missing_unit` stays a single-value boolean pass-through — the
 * "Missing unit" quick view is a preset over that single key (`missing_unit=true`), so
 * the existing `/signals?missing_unit=true` deep link matches by strict set-equality and
 * lights the segment (contract §3, `deep-links.spec.ts` still passes without changes).
 */

const SIGNAL_COLUMNS = 7;

/* The CSV carries the stored value of each column, never the screen glyph:
   the raw rate, the raw timestamps and an empty field for a missing unit. */
const SIGNAL_CSV_COLUMNS: readonly CsvColumn<SignalCatalogEntry>[] = [
  { header: "Signal", value: (signal) => signal.name },
  { header: "Description", value: (signal) => signal.description },
  { header: "Unit", value: (signal) => signal.unit },
  { header: "Unit source", value: (signal) => signal.unit_source },
  { header: "Data type", value: (signal) => signal.dtype },
  { header: "Typical rate Hz", value: (signal) => signal.typical_rate_hz, type: "number" },
  { header: "Runs", value: (signal) => signal.run_count, type: "number" },
  { header: "First seen", value: (signal) => signal.first_seen, type: "date" },
  { header: "Last seen", value: (signal) => signal.last_seen, type: "date" },
];

/* The unit, the rate and the rig options come from `GET /signals/facets`,
   never from a typed list and never from a page.

   The typed list held the six units of the seed, so rpm, Nm, bar and every
   unit a person types had no entry in the filter. One unfiltered page of 500
   replaced it, and that page still covered 8 per cent of 6,412 signals. The
   list sorts `last_seen` desc and `PATCH /signals/{name}` does not move
   `last_seen`, so a corrected unit on an OLD signal stayed out of the filter.
   The facets route reads the whole catalog, so the hole is closed and the
   coverage note is gone. */
const mono = (text: string) => <span className="font-mono text-[0.78rem]">{text}</span>;

// The route sorts every list ascending, so the popover order is already stable.
const monoOptions = (values: readonly string[] | undefined): FilterOption[] =>
  (values ?? []).map((value) => ({ value, label: mono(value) }));

/* The provenance tag, not the producing system. `GET /signals` takes `source`
   beside `source_system`, and `tm signals` names both, so the screen must offer
   both — the fourth acceptance clause of FR-DM-111 asks the three interfaces to
   query the same way.

   The six values are the whole `Source` enum (`api/api/models/common.py`).
   They are a closed wire list, not a catalog value, so no facet feeds them and
   the list never shortens to what one page happens to hold. The runs screen
   reads the same key from the URL and prints the same pill; its toolbar mounts
   no control yet. */
const SOURCE_OPTIONS: readonly FilterOption[] = (
  [
    "embedded",
    "manual",
    "api:planning",
    "api:config",
    "api:catalogue",
    "api:post-processing",
  ] as const
).map((value) => ({
  value,
  label: <SourceBadge source={value} />,
  // The badge is a node, so the checkbox would be named by the bare wire word.
  description: sourceMeaning(value),
}));

const SIGNALS_TABLE_CONFIG: TableStateConfig = {
  // `dtype` and `source_system` join the repeated-param keys (FR-DM-111).
  // The workbook asks to query a signal by its type and by the system that
  // produced it, and both are stored fields with a facet behind them.
  // `source` joins the repeated-param keys (TR-011). The pill clears through
  // `toggleFilterValue`, and that setter acts on a multi key alone.
  multiKeys: ["unit", "rate", "rig", "dtype", "source_system", "source"] as const,
  // `missing_unit` is a single-value boolean pass-through — matches Wave 1's mock/db
  // handling (`SignalListFilters.missing_unit?: boolean`) and the existing deep link.
  singleKeys: ["missing_unit"] as const,
  sortKeys: ["name", "typical_rate_hz", "run_count", "last_seen"] as const,
  defaultSort: { key: "last_seen", order: "desc" },
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100, 200, 500] as const,
  quickViews: [
    { id: "all", params: {} },
    { id: "missing", params: { missing_unit: ["true"] } },
  ] as const,
};

// Server-default sort direction per key (spec §1.2 — `name` asc, everything else desc).
const FIRST_ORDER: Record<SignalSortKey, "asc" | "desc"> = {
  name: "asc",
  typical_rate_hz: "desc",
  run_count: "desc",
  last_seen: "desc",
};

const ROW_CLASS =
  "cursor-pointer transition-colors hover:bg-surface-2 focus-within:bg-surface-2";

export function SignalsScreen() {
  const table = useTableState(SIGNALS_TABLE_CONFIG, "/signals");
  const { state, activeQuickViewId } = table;

  /* Every panel filter, added up. `missing_unit` is left out: it is the second
     quick view, so counting it would count one choice twice. */
  const disclosure = useDisclosure(
    state.multi.unit.length +
      state.multi.rate.length +
      state.multi.rig.length +
      state.multi.dtype.length +
      state.multi.source_system.length +
      state.multi.source.length,
  );

  const rateValues = useMemo(() => {
    // URL keeps rate as string; the API/mock expects numeric. A rate is a float,
    // so 12.5 Hz must stay 12.5 and must not truncate to 12.
    return state.multi.rate
      .map((v) => Number.parseFloat(v))
      .filter((n) => Number.isFinite(n));
  }, [state.multi.rate]);

  const filters: SignalListFilters = useMemo(() => {
    const next: SignalListFilters = {
      page: state.page,
      page_size: state.pageSize,
    };
    if (state.multi.unit.length > 0) next.unit = state.multi.unit;
    if (rateValues.length > 0) next.rate = rateValues;
    if (state.multi.rig.length > 0) next.rig = state.multi.rig;
    if (state.multi.dtype.length > 0) next.dtype = state.multi.dtype;
    if (state.multi.source_system.length > 0) {
      next.source_system = state.multi.source_system;
    }
    if (state.multi.source.length > 0) {
      next.source = state.multi.source as readonly SourceTag[];
    }
    if (state.single.missing_unit === "true") next.missing_unit = true;
    if (state.q.length > 0) next.q = state.q;
    if (state.sort !== null) {
      next.sort = state.sort.key as SignalSortKey;
      next.order = state.sort.order;
    }
    return next;
  }, [state, rateValues]);

  const signalsQuery = useSignals(filters);
  const envelope = signalsQuery.data;
  const viewCounts = envelope?.view_counts;

  /* The filtered list cannot feed the options: after a unit selection it holds
     that unit only, and the user could then never add a second unit. The
     facets route takes no filter and no page, so it answers the whole
     catalog in one call. The rigs come from `rig_ids`, which is the field
     the `rig` filter matches, so every option filters something. */
  const facets = useSignalFacets().data;

  const unitOptions = useMemo(() => monoOptions(facets?.units), [facets]);
  const rateOptions = useMemo(
    () => (facets?.rates ?? []).map((hz) => ({ value: String(hz), label: mono(`${hz} Hz`) })),
    [facets]
  );
  const rigOptions = useMemo(() => monoOptions(facets?.rigs), [facets]);
  const dtypeOptions = useMemo(() => monoOptions(facets?.dtypes), [facets]);
  const sourceSystemOptions = useMemo(
    () => monoOptions(facets?.source_systems),
    [facets]
  );

  const quickViews: readonly QuickView[] = [
    { id: "all", label: "All", count: viewCounts?.all },
    { id: "missing", label: "Missing unit", count: viewCounts?.missing_unit },
  ];

  // Pills: one per applied multi value + missing_unit + q.
  const pills: readonly FilterPill[] = useMemo(() => {
    const list: FilterPill[] = [];
    for (const value of state.multi.unit) {
      list.push({
        id: `unit:${value}`,
        group: "Unit",
        label: value,
        onRemove: () => table.toggleFilterValue("unit", value),
      });
    }
    for (const value of state.multi.rate) {
      list.push({
        id: `rate:${value}`,
        group: "Rate",
        label: `${value} Hz`,
        onRemove: () => table.toggleFilterValue("rate", value),
      });
    }
    for (const value of state.multi.rig) {
      list.push({
        id: `rig:${value}`,
        group: "Rig",
        label: value,
        onRemove: () => table.toggleFilterValue("rig", value),
      });
    }
    for (const value of state.multi.dtype) {
      list.push({
        id: `dtype:${value}`,
        group: "Data type",
        label: value,
        onRemove: () => table.toggleFilterValue("dtype", value),
      });
    }
    for (const value of state.multi.source_system) {
      list.push({
        id: `source_system:${value}`,
        group: "Source system",
        label: value,
        onRemove: () => table.toggleFilterValue("source_system", value),
      });
    }
    for (const value of state.multi.source) {
      list.push({
        id: `source:${value}`,
        group: "Source",
        label: value,
        onRemove: () => table.toggleFilterValue("source", value),
      });
    }
    if (state.single.missing_unit === "true") {
      list.push({
        id: "missing_unit",
        group: "Filter",
        label: "Missing unit",
        // Clear the single key by switching to the "all" preset.
        onRemove: () => table.setQuickView("all"),
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
    state.multi.unit.length > 0 ||
    state.multi.rate.length > 0 ||
    state.multi.rig.length > 0 ||
    state.multi.dtype.length > 0 ||
    state.multi.source_system.length > 0 ||
    state.multi.source.length > 0 ||
    state.single.missing_unit !== undefined ||
    state.q.length > 0;

  const items = envelope?.items ?? [];
  const showEmpty =
    signalsQuery.isSuccess && items.length === 0 && (hasActiveFilters || (envelope?.total ?? 0) === 0);

  return (
    <FullHeightPage>
      <PageHeader
        title="Signals"
        sub="Cross-run signal catalog — signals are cataloged automatically at ingestion."
      />
      {/* Toolbar: [segment] [search] [spacer] [multi-select popovers] — mock parity. */}
      <ToolbarRow
        actions={
          <>
            <ToolbarFiltersButton disclosure={disclosure} />
            <ExportButton
              total={envelope?.total ?? 0}
              fetchPage={(page, pageSize) =>
                signalsApi.list({ ...filters, page, page_size: pageSize })
              }
              columns={SIGNAL_CSV_COLUMNS}
              list="signals"
              scope="signals"
              serverExport={{ path: "/signals/export", params: filters }}
            />
          </>
        }
      >
        <QuickViewSegment
          views={quickViews}
          activeId={activeQuickViewId}
          onSelect={(id) => table.setQuickView(id)}
          aria-label="Signals quick views"
        />
        <ToolbarDivider />
        <TableSearchInput
          value={state.q}
          onDebouncedChange={(value) => table.setQ(value)}
          placeholder="Filter signals…"
        />
      </ToolbarRow>

      {/* Six filters. This screen is the reason the panel exists: in one flat
          row they and the export pushed the toolbar onto a third line. */}
      <ToolbarPanel disclosure={disclosure}>
        <ToolbarGroupLabel>Filter</ToolbarGroupLabel>
        <MultiSelectFilter
          label="Unit"
          options={unitOptions}
          emptyText="No values in the catalog."
          selected={state.multi.unit}
          onChange={(next) => table.setFilterValues("unit", next)}
        />
        <MultiSelectFilter
          label="Rate"
          options={rateOptions}
          emptyText="No values in the catalog."
          selected={state.multi.rate}
          onChange={(next) => table.setFilterValues("rate", next)}
        />
        <MultiSelectFilter
          label="Rig"
          options={rigOptions}
          emptyText="No values in the catalog."
          selected={state.multi.rig}
          onChange={(next) => table.setFilterValues("rig", next)}
        />
        <MultiSelectFilter
          label="Data type"
          options={dtypeOptions}
          emptyText="No values in the catalog."
          selected={state.multi.dtype}
          onChange={(next) => table.setFilterValues("dtype", next)}
        />
        <MultiSelectFilter
          label="Source system"
          options={sourceSystemOptions}
          emptyText="No values in the catalog."
          selected={state.multi.source_system}
          onChange={(next) => table.setFilterValues("source_system", next)}
        />
        <MultiSelectFilter
          label="Source"
          options={SOURCE_OPTIONS}
          selected={state.multi.source}
          onChange={(next) => table.setFilterValues("source", next)}
        />

        <div className="ml-auto">
          <SavedSearchButton
            scope="signals"
            pathname="/signals"
            query={table.buildQuery(state)}
          />
        </div>
      </ToolbarPanel>

      <div className="mb-2.5" />
      <ActiveFilterPills pills={pills} onClearAll={() => table.clearAll()} />
      <Panel className="flex min-h-0 flex-1 flex-col">
        <TableScrollArea>
          <table aria-label="Signal catalog" className="w-full">
          <thead>
            <tr>
              <SortableTh
                label="Signal"
                sortKey="name"
                active={state.sort}
                onSort={(key) => table.setSort(key, FIRST_ORDER.name)}
              />
              <th>Unit</th>
              <SortableTh
                label="Rate"
                sortKey="typical_rate_hz"
                active={state.sort}
                onSort={(key) => table.setSort(key, FIRST_ORDER.typical_rate_hz)}
                numeric
              />
              <th>Type</th>
              <SortableTh
                label="Seen in"
                sortKey="run_count"
                active={state.sort}
                onSort={(key) => table.setSort(key, FIRST_ORDER.run_count)}
                numeric
              />
              <th>First seen</th>
              <SortableTh
                label="Last seen"
                sortKey="last_seen"
                active={state.sort ?? SIGNALS_TABLE_CONFIG.defaultSort}
                onSort={(key) => table.setSort(key, FIRST_ORDER.last_seen)}
              />
            </tr>
          </thead>
          <tbody>
            {signalsQuery.isPending && <LoadingRows rows={7} cols={SIGNAL_COLUMNS} />}
            {signalsQuery.isError && (
              <tr>
                <td colSpan={SIGNAL_COLUMNS}>
                  <ErrorState
                    message="Could not load the signal catalog."
                    onRetry={() => void signalsQuery.refetch()}
                  />
                </td>
              </tr>
            )}
            {showEmpty && (
              <TableEmptyState
                colSpan={SIGNAL_COLUMNS}
                onClearAll={() => table.clearAll()}
                message="No signals match the current filters."
              />
            )}
            {items.map((signal) => (
              <RowLink
                key={signal.name}
                variant="plain"
                href={`/signals/${encodeURIComponent(signal.name)}`}
                className={ROW_CLASS}
              >
                <td>
                  <RowLinkLabel>
                    <span className="font-mono text-[0.78rem]">{signal.name}</span>
                  </RowLinkLabel>
                  <div className="mt-px text-[0.72rem] text-ink-3">{signal.description ?? "—"}</div>
                </td>
                <td>
                  {signal.unit !== null ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-mono text-[0.78rem]">{signal.unit}</span>
                      {signal.unit_source !== null && (
                        <SourceBadge source={signal.unit_source} />
                      )}
                    </span>
                  ) : (
                    <>
                      <ToneBadge tone="amber" dot>
                        missing
                      </ToneBadge>
                      <div className="mt-px text-[0.72rem] text-ink-3">
                        no unit in file — manual entry allowed
                      </div>
                    </>
                  )}
                </td>
                <td className="text-right font-mono text-[0.78rem]">
                  {signal.typical_rate_hz} Hz
                </td>
                <td>{baseDtype(signal.dtype)}</td>
                <td className="text-right font-mono text-[0.78rem]">
                  {signal.run_count} runs
                </td>
                <td>{formatDay(signal.first_seen)}</td>
                <td>{formatDay(signal.last_seen)}</td>
              </RowLink>
            ))}
          </tbody>
        </table>
        </TableScrollArea>
        {envelope !== undefined && (
          <TablePager
            page={envelope.page}
            pageSize={envelope.page_size}
            total={envelope.total}
            totalPages={envelope.total_pages}
            onPageChange={(page) => table.setPage(page)}
            onPageSizeChange={(size) => table.setPageSize(size)}
          />
        )}
      </Panel>
    </FullHeightPage>
  );
}
