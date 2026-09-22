"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActiveFilterPills, type FilterPill } from "@/components/shared/active-filter-pills";
import { ErrorState } from "@/components/shared/error-state";
import { ExportButton } from "@/components/shared/export-button";
import { SavedSearchButton } from "@/components/shared/saved-search-button";
import { LoadingRows } from "@/components/shared/loading-rows";
import { MultiSelectFilter, type FilterOption } from "@/components/shared/multi-select-filter";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, TableScrollArea } from "@/components/shared/panel";
import { QuickViewSegment, type QuickView } from "@/components/shared/quick-view-segment";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ToolbarDivider,
  ToolbarFiltersButton,
  ToolbarGroupLabel,
  ToolbarPanel,
  ToolbarRow,
  useDisclosure,
} from "@/components/shared/table-toolbar";
import { SortableTh } from "@/components/shared/sortable-th";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import { filesApi } from "@/lib/api/files";
import { formatBytes } from "@/lib/format";
import { useFiles } from "@/lib/hooks";
import { useTableState, type TableStateConfig } from "@/lib/table-state";
import type { CsvColumn } from "@/lib/table-csv";
import type {
  FileEntity,
  FileLifecycle,
  FileListFilters,
  FileSortKey,
  FileStatus,
  SortOrder,
  SourceSystem,
} from "@/types";
import { DownloadButton } from "./download-button";
import { FilesBatchBar } from "./files-batch-bar";
import { shortChecksum } from "./format";
import { LifecycleBadge } from "./lifecycle-badge";

/* --------------------------------------------------------------------------
 * URL uses `source` (existing deep links), API uses `source_system` — mapped
 * in the fetch layer here per spec §3. Config is module-level for stable
 * identity across renders.
 * -------------------------------------------------------------------------- */

const SOURCE_OPTIONS: readonly FilterOption[] = [
  { value: "TAS", label: <ToneBadge tone="neutral">TAS</ToneBadge> },
  { value: "INCA", label: <ToneBadge tone="neutral">INCA</ToneBadge> },
  { value: "ifile", label: <ToneBadge tone="neutral">ifile</ToneBadge> },
  /* "api" marks a file that reached the registry through the registry API
     itself — an uploaded processed result, for one. Without the option here
     those files existed in the table but no filter could isolate them. */
  { value: "api", label: <ToneBadge tone="neutral">api</ToneBadge> },
];

const FILES_TABLE_CONFIG: TableStateConfig = {
  multiKeys: ["status", "source", "lifecycle"],
  /* `invalid` carries the "Hide invalid" tick. It is a single key, so the URL
     holds `invalid=false` and the fetch layer forwards it to the route's own
     `invalid` parameter (`api/api/routers/files.py`). Absent means the mark
     hides nothing, which is the default this screen has always shown. */
  singleKeys: ["run", "unlinked", "invalid"],
  /* Hiding must combine with a view, not replace one. A person wants the
     registered files WITHOUT the invalid ones. See `independentKeys` in
     `lib/table-state.ts`. */
  independentKeys: ["invalid"],
  sortKeys: ["registered_at", "size_bytes"],
  defaultSort: { key: "registered_at", order: "desc" },
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100, 200, 500],
  /* The plain table holds the active files only, so an archived file left it
     with nowhere to go. The two named views are the route's own
     `lifecycle=archived` and `lifecycle=deleted` (`api/api/routers/files.py`).
     A delete is a soft delete: the registry keeps every byte. */
  quickViews: [
    { id: "all", params: {} },
    { id: "registered", params: { status: ["registered"] } },
    { id: "quarantined", params: { status: ["quarantined"] } },
    { id: "archived", params: { lifecycle: ["archived"] } },
    { id: "deleted", params: { lifecycle: ["deleted"] } },
  ],
};

const FILE_LIFECYCLE_LABELS: Record<FileLifecycle, string> = {
  active: "Active",
  archived: "Archived",
  deleted: "Deleted",
};

const FILE_STATUS_LABELS: Record<FileStatus, string> = {
  registered: "Registered",
  quarantined: "Quarantined",
};

const ROW_CLASS =
  "cursor-pointer outline-none transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

const COL_COUNT = 8;

/* The CSV carries the stored value of each column, never the screen glyph:
   the whole checksum, the raw byte count and the raw timestamps. */
const FILE_CSV_COLUMNS: readonly CsvColumn<FileEntity>[] = [
  { header: "File id", value: (file) => file.file_id },
  { header: "Filename", value: (file) => file.filename },
  { header: "Run", value: (file) => file.run_id },
  { header: "Source", value: (file) => file.source_system },
  { header: "Format", value: (file) => file.format },
  { header: "Size bytes", value: (file) => file.size_bytes, type: "number" },
  { header: "Checksum SHA-256", value: (file) => file.checksum_sha256 },
  { header: "Checksum state", value: (file) => file.checksum_state },
  { header: "Status", value: (file) => file.status },
  { header: "Quarantine reason", value: (file) => file.quarantine_reason },
  { header: "Lifecycle", value: (file) => file.lifecycle ?? "active" },
  { header: "Invalid", value: (file) => String(file.invalid?.flagged ?? false) },
  { header: "Invalid reason", value: (file) => file.invalid?.reason ?? null },
  { header: "Version", value: (file) => file.version ?? 1, type: "number" },
  { header: "Signals", value: (file) => file.signal_count, type: "number" },
  { header: "Time start", value: (file) => file.time_start, type: "date" },
  { header: "Time end", value: (file) => file.time_end, type: "date" },
  { header: "Registered", value: (file) => file.registered_at, type: "date" },
];

export function FilesScreen() {
  const router = useRouter();
  const table = useTableState(FILES_TABLE_CONFIG, "/files");
  const { state, activeQuickViewId } = table;

  /* Only `source` and the invalid tick live in the panel here. Status and
     lifecycle are the quick views, so counting them would count the same
     choice twice. */
  const hideInvalid = state.single.invalid === "false";
  const disclosure = useDisclosure(
    (state.multi.source?.length ?? 0) + (state.single.invalid !== undefined ? 1 : 0),
  );

  const filters = useMemo<FileListFilters>(() => {
    const next: FileListFilters = { page: state.page, page_size: state.pageSize };
    const status = state.multi.status as readonly FileStatus[] | undefined;
    const source = state.multi.source as readonly SourceSystem[] | undefined;
    const lifecycle = state.multi.lifecycle as readonly FileLifecycle[] | undefined;
    if (status && status.length > 0) next.status = status;
    if (source && source.length > 0) next.source_system = source;
    if (lifecycle && lifecycle.length > 0) next.lifecycle = lifecycle;
    if (state.single.run !== undefined) next.run = state.single.run;
    if (state.single.unlinked !== undefined) next.unlinked = state.single.unlinked === "true";
    if (state.single.invalid !== undefined) next.invalid = state.single.invalid === "true";
    if (state.q.length > 0) next.q = state.q;
    if (state.sort !== null) {
      next.sort = state.sort.key as FileSortKey;
      next.order = state.sort.order as SortOrder;
    }
    return next;
  }, [state]);

  // Poll: runbook Act 1 sends the presenter here while the six files land.
  const filesQuery = useFiles(filters, { poll: true });
  const viewCounts = filesQuery.data?.view_counts;

  const quickViews: readonly QuickView[] = useMemo(
    () => [
      { id: "all", label: "All", count: viewCounts?.all },
      { id: "registered", label: "Registered", count: viewCounts?.registered },
      { id: "quarantined", label: "Quarantined", count: viewCounts?.quarantined },
      { id: "archived", label: "Archived", count: viewCounts?.archived },
      { id: "deleted", label: "Deleted", count: viewCounts?.deleted },
    ],
    [viewCounts]
  );

  const pills = useMemo<readonly FilterPill[]>(() => {
    const list: FilterPill[] = [];
    for (const value of state.multi.status ?? []) {
      list.push({
        id: `status:${value}`,
        group: "Status",
        label: FILE_STATUS_LABELS[value as FileStatus] ?? value,
        onRemove: () => table.toggleFilterValue("status", value),
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
    for (const value of state.multi.lifecycle ?? []) {
      list.push({
        id: `lifecycle:${value}`,
        group: "Lifecycle",
        label: FILE_LIFECYCLE_LABELS[value as FileLifecycle] ?? value,
        onRemove: () => table.toggleFilterValue("lifecycle", value),
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
    if (state.single.unlinked !== undefined) {
      list.push({
        id: "unlinked",
        group: "Unlinked",
        label: state.single.unlinked,
        onRemove: () => table.setFilterValues("unlinked", []),
      });
    }
    /* The tick writes `invalid=false` and nothing else, but a deep link can
       still carry `invalid=true`. Name what the URL actually asks for, so the
       pill never claims the opposite of the filter it removes. */
    if (state.single.invalid !== undefined) {
      list.push({
        id: "invalid",
        group: "Invalid",
        label: state.single.invalid === "false" ? "Hidden" : "Only invalid",
        onRemove: () => table.setFilterValues("invalid", []),
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

  const total = filesQuery.data?.total ?? 0;
  const totalPages = filesQuery.data?.total_pages ?? 1;
  const hasActiveFilters = pills.length > 0 || activeQuickViewId !== "all";

  /* Row selection — FR-DM-078. It follows `run-detail/signals-tab.tsx`: the
     header box covers THIS PAGE, and a row box covers its row.

     Two rules keep a hidden pick out of a batch. The selection drops when the
     filters or the page change, and the bar reads the rows on screen, never the
     raw state. So a file the table no longer shows can never take a write. */
  const filterKey = JSON.stringify(filters);
  /* The selection carries the filter state and the page it belongs to. A change
     to either gives a new key, so the old pick drops in the same render that
     draws the new rows. No effect, and no frame where a stale pick can act. */
  const [picked, setPicked] = useState<{ key: string; ids: readonly string[] }>({
    key: filterKey,
    ids: [],
  });
  const pickedIds = picked.key === filterKey ? picked.ids : [];
  const setPickedIds = (ids: readonly string[]) => setPicked({ key: filterKey, ids });

  const rows = filesQuery.data?.items ?? [];
  const pickedSet = new Set(pickedIds);
  const pickedRows = rows.filter((file) => pickedSet.has(file.file_id));
  const wholePage = rows.length > 0 && pickedRows.length === rows.length;
  const partPage = pickedRows.length > 0 && !wholePage;

  const togglePick = (fileId: string) => {
    setPickedIds(
      pickedSet.has(fileId) ? pickedIds.filter((id) => id !== fileId) : [...pickedIds, fileId],
    );
  };

  const togglePage = () => {
    setPickedIds(wholePage ? [] : rows.map((file) => file.file_id));
  };

  return (
    <FullHeightPage>
      <PageHeader
        title="Files"
        sub="Every file registered with checksum and provenance. Unlinked files are quarantined, never dropped."
      />

      <ToolbarRow
        actions={
          <>
            <ToolbarFiltersButton disclosure={disclosure} />
            <ExportButton
              total={filesQuery.data?.total ?? 0}
              fetchPage={(page, pageSize) =>
                filesApi.list({ ...filters, page, page_size: pageSize })
              }
              columns={FILE_CSV_COLUMNS}
              list="files"
              scope="files"
              serverExport={{ path: "/files/export", params: filters }}
            />
          </>
        }
      >
        <QuickViewSegment
          views={quickViews}
          activeId={activeQuickViewId}
          onSelect={table.setQuickView}
          aria-label="File quick views"
        />
        <ToolbarDivider />
        <TableSearchInput
          value={state.q}
          onDebouncedChange={table.setQ}
          placeholder="Filter files…"
        />
      </ToolbarRow>

      <ToolbarPanel disclosure={disclosure}>
        <ToolbarGroupLabel>Filter</ToolbarGroupLabel>
        <MultiSelectFilter
          label="Source"
          options={SOURCE_OPTIONS}
          selected={state.multi.source ?? []}
          onChange={(next) => table.setFilterValues("source", next)}
        />

        <ToolbarDivider />
        {/* A tick, not a sixth quick view. The views are exclusive, and a
            person wants the registered files WITHOUT the invalid ones — one
            choice must not cancel the other. Unticked writes no `invalid` key
            at all, so the default table still shows every file. Who decides
            the default stays the customer's call, and this control does not
            pre-empt it. */}
        {/* The wrapping label names the box: base-ui points the box's own
            `aria-labelledby` at it. An `aria-label` here as well would NOT
            override that — it would join it, and the box would announce
            "Hide invalid files Hide invalid files". */}
        <label className="flex cursor-pointer items-center gap-2.5 text-[0.76rem] text-ink-2">
          <Checkbox
            checked={hideInvalid}
            onCheckedChange={(next: boolean) =>
              table.setFilterValues("invalid", next ? ["false"] : [])
            }
          />
          <span>Hide invalid files</span>
        </label>

        <div className="ml-auto">
          <SavedSearchButton scope="files" pathname="/files" query={table.buildQuery(state)} />
        </div>
      </ToolbarPanel>

      <div className="mb-2.5" />

      <ActiveFilterPills pills={pills} onClearAll={table.clearAll} />

      {/* The bar renders nothing while nothing is picked, so a person who never
          ticks a box sees the screen it always was. */}
      <FilesBatchBar files={pickedRows} onSelectionChange={setPickedIds} />

      <Panel className="flex min-h-0 flex-1 flex-col">
        <TableScrollArea>
          <table aria-label="Files" className="w-full">
          <thead>
            <tr>
              <th className="w-8">
                <Checkbox
                  checked={wholePage}
                  indeterminate={partPage}
                  disabled={rows.length === 0}
                  onCheckedChange={togglePage}
                  aria-label="Select every file on this page"
                />
              </th>
              {/* NOT sortable. GET /files whitelists `registered_at` and
                  `size_bytes` only — no filename sort exists. This header used
                  to carry `registered_at`, so "sorting by File" reordered the
                  table by registration date: a lie the arrow and aria-sort
                  repeated (FR-DM-091, the runs screen's "Run" header states
                  the same rule). The list still arrives newest first — the
                  server default. A filename sort needs an API key first. */}
              <th>File</th>
              <th>Run</th>
              <th>Source</th>
              <SortableTh
                label="Size"
                sortKey="size_bytes"
                active={state.sort}
                onSort={(key) => table.setSort(key, "desc")}
                numeric
              />
              <th>Checksum</th>
              <th>Status</th>
              <th className="w-9">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filesQuery.isPending && <LoadingRows rows={5} cols={COL_COUNT} />}
            {filesQuery.isError && (
              <tr>
                <td colSpan={COL_COUNT}>
                  <ErrorState
                    message="Could not load files."
                    onRetry={() => void filesQuery.refetch()}
                  />
                </td>
              </tr>
            )}
            {filesQuery.isSuccess &&
              filesQuery.data.items.length === 0 &&
              hasActiveFilters && (
                <TableEmptyState colSpan={COL_COUNT} onClearAll={table.clearAll} />
              )}
            {filesQuery.isSuccess &&
              filesQuery.data.items.length === 0 &&
              !hasActiveFilters && (
                <tr>
                  <td
                    colSpan={COL_COUNT}
                    className="px-4 py-7 text-center text-[0.78rem] text-ink-3"
                  >
                    No files yet.
                  </td>
                </tr>
              )}
            {/* Each row holds a focusable DownloadButton, so it cannot be a
                `role="link"` widget (axe nested-interactive). The filename is
                the real link — the keyboard and SR path — and the row click
                stays as a pointer convenience. */}
            {filesQuery.isSuccess &&
              filesQuery.data.items.map((file) => (
                <tr
                  key={file.file_id}
                  onClick={() => router.push(`/files/${encodeURIComponent(file.file_id)}`)}
                  className={ROW_CLASS}
                >
                  {/* The row click opens the file, so the box stops the event.
                      Ticking a box must never navigate away from the table. */}
                  <td className="w-8" onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      checked={pickedSet.has(file.file_id)}
                      onCheckedChange={() => togglePick(file.file_id)}
                      aria-label={`Select ${file.filename}`}
                    />
                  </td>
                  <td>
                    <Link
                      href={`/files/${encodeURIComponent(file.file_id)}`}
                      className="font-mono text-[0.78rem]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {file.filename}
                    </Link>
                  </td>
                  <td>
                    {file.run_id !== null ? (
                      <Link
                        href={`/runs/${encodeURIComponent(file.run_id)}`}
                        className="font-mono text-[0.78rem] hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {file.run_id}
                      </Link>
                    ) : (
                      <span className="font-mono text-[0.78rem] text-ink-3">unlinked</span>
                    )}
                  </td>
                  <td>
                    <ToneBadge tone="neutral">{file.source_system}</ToneBadge>
                  </td>
                  <td className="text-right font-mono text-[0.78rem]">
                    {formatBytes(file.size_bytes)}
                  </td>
                  <td>
                    {file.checksum_state === "mismatch" ? (
                      <span className="font-mono text-[0.78rem] text-red">mismatch</span>
                    ) : file.checksum_state === "unverified" ? (
                      <span className="font-mono text-[0.78rem] text-ink-3">unverified</span>
                    ) : (
                      <span className="font-mono text-[0.78rem] text-ink-3">
                        {shortChecksum(file.checksum_sha256)}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={file.status} />
                      {/* Two separate fields, so two separate badges. The plain
                          table holds active files only, so it prints none. */}
                      {file.lifecycle !== undefined && file.lifecycle !== "active" && (
                        <LifecycleBadge lifecycle={file.lifecycle} />
                      )}
                      {/* The mark a person raised on the file. It is a third
                          field beside `status` and `lifecycle`, so it gets a
                          third badge and replaces neither. The reason rides in
                          the title, so a reader sees WHY without leaving the
                          table. */}
                      {file.invalid?.flagged === true && (
                        <span title={file.invalid.reason ?? undefined}>
                          <ToneBadge tone="red" dot>
                            Invalid
                          </ToneBadge>
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="w-9 text-right">
                    <DownloadButton
                      fileId={file.file_id}
                      filename={file.filename}
                      sizeBytes={file.size_bytes}
                      quarantined={file.status === "quarantined"}
                      variant="row"
                    />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        </TableScrollArea>
        {filesQuery.data !== undefined && (
          <TablePager
            page={filesQuery.data.page}
            pageSize={filesQuery.data.page_size}
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
