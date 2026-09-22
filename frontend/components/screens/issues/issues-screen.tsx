"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActiveFilterPills, type FilterPill } from "@/components/shared/active-filter-pills";
import { ErrorState } from "@/components/shared/error-state";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { LoadingRows } from "@/components/shared/loading-rows";
import { MultiSelectFilter, type FilterOption } from "@/components/shared/multi-select-filter";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, TableScrollArea } from "@/components/shared/panel";
import { QuickViewSegment, type QuickView } from "@/components/shared/quick-view-segment";
import { SortableTh } from "@/components/shared/sortable-th";
import {
  IssueOpenButtons,
  KindBadge,
  STATE_LABEL,
  StateBadge,
} from "@/components/screens/issues/issue-detail";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import {
  ToolbarDivider,
  ToolbarFiltersButton,
  ToolbarGroupLabel,
  ToolbarPanel,
  ToolbarRow,
  useDisclosure,
} from "@/components/shared/table-toolbar";
import { Badge } from "@/components/ui/badge";
import { lakeTable } from "@/lib/explore/lake-schema";
import { formatTime } from "@/lib/format";
import { useAllSnippets } from "@/lib/hooks";
import { issueHref } from "@/lib/snippets/issue-link";
import {
  formatFrame,
  formatSpan,
  searchSnippets,
  snippetFacets,
  snippetFrame,
  snippetNote,
  snippetRuns,
  snippetSource,
  snippetTags,
  sortSnippets,
  type SnippetSortKey,
  type SnippetState,
  type SortDir,
} from "@/lib/snippets/anomalies";
import { useTableState, type TableStateConfig } from "@/lib/table-state";

/* The filters live in the URL the way every list screen's do (`lib/table-state.ts`), so a
   link carries them and the pills, the quick views and the pager all read one state. The
   rows come from the lake in one call and are filtered here: the lake lists a table's
   snippets whole, and a run's issues are a few dozen. */
const ISSUES_TABLE_CONFIG: TableStateConfig = {
  multiKeys: ["state", "kind", "store"],
  singleKeys: ["run"],
  sortKeys: ["updated", "name", "kind", "state"],
  defaultSort: { key: "updated", order: "desc" },
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100],
  quickViews: [
    { id: "all", params: {} },
    { id: "open", params: { state: ["open"] } },
    { id: "resolved", params: { state: ["resolved"] } },
    { id: "closed", params: { state: ["closed"] } },
  ],
};

const ROW_CLASS =
  "cursor-pointer outline-none transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

const COL_COUNT = 10;


export function IssuesScreen() {
  const router = useRouter();
  const table = useTableState(ISSUES_TABLE_CONFIG, "/issues");
  const { state, activeQuickViewId } = table;
  const query = useAllSnippets();
  const all = useMemo(() => query.data?.snippets ?? [], [query.data]);
  const facets = useMemo(() => snippetFacets(all), [all]);

  /* Kind and store live in the panel; state is the quick views, so counting it would count
     one choice twice. The run pill counts: it arrives from a run page link. */
  const disclosure = useDisclosure(
    (state.multi.kind?.length ?? 0) +
      (state.multi.store?.length ?? 0) +
      (state.single.run !== undefined ? 1 : 0),
  );

  const shown = useMemo(() => {
    const states = (state.multi.state ?? []) as SnippetState[];
    const kinds = state.multi.kind ?? [];
    const stores = state.multi.store ?? [];
    let rows = all.filter((s) => {
      const t = snippetTags(s);
      if (states.length > 0 && (t.state === null || !states.includes(t.state))) return false;
      if (kinds.length > 0 && !kinds.includes(t.kind)) return false;
      if (stores.length > 0 && (t.store === null || !stores.includes(t.store))) return false;
      if (state.single.run !== undefined && !snippetRuns(s).includes(state.single.run)) return false;
      return true;
    });
    rows = searchSnippets(rows, state.q);
    const key = (state.sort?.key ?? "updated") as SnippetSortKey;
    const dir = (state.sort?.order ?? "desc") as SortDir;
    return sortSnippets(rows, key, dir);
  }, [all, state]);

  const total = shown.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const rows = shown.slice((page - 1) * state.pageSize, page * state.pageSize);

  const quickViews: readonly QuickView[] = useMemo(
    () => [
      { id: "all", label: "All", count: query.data ? all.length : undefined },
      { id: "open", label: "Open", count: query.data ? facets.states.open : undefined },
      { id: "resolved", label: "Resolved", count: query.data ? facets.states.resolved : undefined },
      { id: "closed", label: "Closed", count: query.data ? facets.states.closed : undefined },
    ],
    [query.data, all.length, facets],
  );

  const kindOptions: readonly FilterOption[] = facets.kinds.map((k) => ({
    value: k,
    label: (
      <Badge variant="outline" className="font-mono">
        {k}
      </Badge>
    ),
  }));
  const storeOptions: readonly FilterOption[] = facets.stores.map((k) => ({
    value: k,
    label: <span className="font-mono text-[0.78rem]">{k}</span>,
  }));

  const pills = useMemo<readonly FilterPill[]>(() => {
    const list: FilterPill[] = [];
    for (const value of state.multi.state ?? []) {
      list.push({
        id: `state:${value}`,
        group: "State",
        label: STATE_LABEL[value as SnippetState] ?? value,
        onRemove: () => table.toggleFilterValue("state", value),
      });
    }
    for (const value of state.multi.kind ?? []) {
      list.push({
        id: `kind:${value}`,
        group: "Kind",
        label: value,
        onRemove: () => table.toggleFilterValue("kind", value),
      });
    }
    for (const value of state.multi.store ?? []) {
      list.push({
        id: `store:${value}`,
        group: "Store",
        label: value,
        onRemove: () => table.toggleFilterValue("store", value),
      });
    }
    if (state.single.run !== undefined) {
      list.push({
        id: "run",
        group: "Run",
        label: state.single.run,
        onRemove: () => table.setFilterValues("run", []),
      });
    }
    if (state.q.length > 0) {
      list.push({ id: "q", group: "Search", label: `“${state.q}”`, onRemove: () => table.setQ("") });
    }
    return list;
  }, [state, table]);

  const hasActiveFilters = pills.length > 0 || activeQuickViewId !== "all";
  const empty = query.isSuccess && rows.length === 0;

  return (
    <FullHeightPage>
      <PageHeader
        title="Issues"
        sub={`Every finding QuixLab wrote to the lake's data snippets over ${lakeTable()}, across every run. Open needs attention; resolved and closed are done.`}
      />

      <ToolbarRow actions={<ToolbarFiltersButton disclosure={disclosure} />}>
        <QuickViewSegment
          views={quickViews}
          activeId={activeQuickViewId}
          onSelect={table.setQuickView}
          aria-label="Issue quick views"
        />
        <ToolbarDivider />
        <TableSearchInput
          value={state.q}
          onDebouncedChange={table.setQ}
          placeholder="Filter issues…"
        />
      </ToolbarRow>

      <ToolbarPanel disclosure={disclosure}>
        <ToolbarGroupLabel>Filter</ToolbarGroupLabel>
        <MultiSelectFilter
          label="Kind"
          options={kindOptions}
          selected={state.multi.kind ?? []}
          onChange={(next) => table.setFilterValues("kind", next)}
        />
        <MultiSelectFilter
          label="Store"
          options={storeOptions}
          selected={state.multi.store ?? []}
          onChange={(next) => table.setFilterValues("store", next)}
        />
      </ToolbarPanel>

      <div className="mb-2.5" />

      <ActiveFilterPills pills={pills} onClearAll={table.clearAll} />

      <Panel className="flex min-h-0 flex-1 flex-col">
        <TableScrollArea>
          <table aria-label="Issues" className="w-full">
            <thead>
              <tr>
                <SortableTh
                  label="Issue"
                  sortKey="name"
                  active={state.sort}
                  onSort={(key) => table.setSort(key, "asc")}
                />
                <th>Note</th>
                <th>Run</th>
                <th>Source</th>
                <th>Period</th>
                <SortableTh
                  label="Kind"
                  sortKey="kind"
                  active={state.sort}
                  onSort={(key) => table.setSort(key, "asc")}
                />
                <SortableTh
                  label="State"
                  sortKey="state"
                  active={state.sort}
                  onSort={(key) => table.setSort(key, "asc")}
                />
                <th>Found by</th>
                <SortableTh
                  label="Updated"
                  sortKey="updated"
                  active={state.sort}
                  onSort={(key) => table.setSort(key, "desc")}
                  numeric
                />
                <th className="w-16">
                  <span className="sr-only">Open in</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {query.isPending && <LoadingRows rows={5} cols={COL_COUNT} />}
              {query.isError && (
                <tr>
                  <td colSpan={COL_COUNT}>
                    <ErrorState
                      message="Could not read the lake's data snippets."
                      onRetry={() => void query.refetch()}
                    />
                  </td>
                </tr>
              )}
              {empty && hasActiveFilters && (
                <TableEmptyState colSpan={COL_COUNT} onClearAll={table.clearAll} />
              )}
              {empty && !hasActiveFilters && (
                <tr>
                  <td colSpan={COL_COUNT} className="px-4 py-7 text-center text-[0.78rem] text-ink-3">
                    No issues yet. QuixLab adds one per finding it makes.
                  </td>
                </tr>
              )}
              {rows.map((s) => {
                const t = snippetTags(s);
                const frame = snippetFrame(s);
                const src = snippetSource(s);
                const runs = snippetRuns(s);
                const run = runs[0] ?? null;
                const href = issueHref(s.id);
                return (
                  <tr
                    key={s.id}
                    className={ROW_CLASS}
                    onClick={() => router.push(href)}
                  >
                    <td className="max-w-[22rem] truncate font-medium text-ink-1">
                      <Link href={href} onClick={(e) => e.stopPropagation()} title={s.name}>
                        {s.name}
                      </Link>
                    </td>
                    <td className="max-w-[24rem] truncate text-ink-2">
                      {snippetNote(s.markdown) || "—"}
                    </td>
                    <td className="font-mono text-[0.72rem] whitespace-nowrap">
                      {runs.length === 0 && <span className="text-ink-3">—</span>}
                      {runs.slice(0, 2).map((r) => (
                        <Link
                          key={r}
                          href={`/runs/${encodeURIComponent(r)}?tab=anomalies`}
                          className="block hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r}
                        </Link>
                      ))}
                      {runs.length > 2 && (
                        <span className="text-ink-3" title={runs.slice(2).join("\n")}>
                          +{runs.length - 2} more
                        </span>
                      )}
                    </td>
                    <td className="font-mono text-[0.72rem] text-ink-2">
                      {[src.scope, src.signal].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="font-mono text-[0.72rem] text-ink-2 whitespace-nowrap">
                      {frame
                        ? `${formatFrame(frame).split(" → ")[0].replace(/ Z$/, "")} · ${formatSpan(frame)}`
                        : "—"}
                    </td>
                    <td>
                      <span className="flex flex-wrap items-center gap-1">
                        <KindBadge kind={t.kind} />
                        {t.reference && <Badge variant="secondary">reference</Badge>}
                      </span>
                    </td>
                    <td>
                      <StateBadge state={t.state} />
                    </td>
                    <td className="font-mono text-[0.72rem] text-ink-2 whitespace-nowrap">
                      {[t.store, t.analysis].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="text-right font-mono text-[0.72rem] whitespace-nowrap">
                      {s.updated_at ? formatTime(s.updated_at) : "—"}
                    </td>
                    <td className="text-right">
                      <span className="flex items-center justify-end gap-1">
                        <IssueOpenButtons snippet={s} runId={run} iconOnly />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScrollArea>
        {query.isSuccess && (
          <TablePager
            page={page}
            pageSize={state.pageSize}
            total={total}
            totalPages={totalPages}
            onPageChange={table.setPage}
            onPageSizeChange={table.setPageSize}
          />
        )}
      </Panel>
    </FullHeightPage>
  );
}
