"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ActiveFilterPills, type FilterPill } from "@/components/shared/active-filter-pills";
import { ErrorState } from "@/components/shared/error-state";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { LoadingRows } from "@/components/shared/loading-rows";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, TableScrollArea } from "@/components/shared/panel";
import { QuickViewSegment, type QuickView } from "@/components/shared/quick-view-segment";
import { SortableTh } from "@/components/shared/sortable-th";
import { ToneBadge } from "@/components/shared/status-badge";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import { ToolbarDivider, ToolbarRow } from "@/components/shared/table-toolbar";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import {
  deleteNotebook,
  openNotebook,
  running,
  stopNotebook,
  type Notebook,
} from "@/lib/api/run-quixlab";
import { formatTime } from "@/lib/format";
import { useAllNotebooks } from "@/lib/hooks";
import { keys } from "@/lib/hooks/keys";
import { useTableState, type TableStateConfig } from "@/lib/table-state";
import { cn } from "@/lib/utils";

/**
 * Workflows: every QuixLab notebook of every run, in one list, with the controls the run's
 * own Notebooks tab has — Open, Start, Stop, Delete.
 *
 * It is the Issues page's shape on purpose: one read of everything, the filters in the URL
 * (`lib/table-state.ts`), quick views on the state, a pager. **Open goes to the run.** A
 * notebook opens inside its run page, where the frame has the signal pick and the whole
 * content area, so Open is a link to `/runs/<id>?tab=notebooks&notebook=<nb>` and the tab
 * starts the lab and embeds it. Start, Stop and Delete act here, because none needs the
 * frame: Start makes or restarts this viewer's lab so it is warm when the person gets to it.
 */

/** The state of this viewer's lab on a notebook, as the list reads it. */
export type LabState = "running" | "starting" | "stopped" | "none";

export function labState(notebook: Notebook): LabState {
  const lab = notebook.lab;
  if (lab === null) return "none";
  if (running(lab)) return "running";
  const status = lab.status.trim().toLowerCase();
  return ["stopped", "stopping", ""].includes(status) ? "stopped" : "starting";
}

const STATE_LABEL: Record<LabState, string> = {
  running: "Running",
  starting: "Starting",
  stopped: "Stopped",
  none: "Not started",
};

const STATE_TONE = {
  running: "green",
  starting: "amber",
  stopped: "neutral",
  none: "neutral",
} as const;

const WORKFLOWS_TABLE_CONFIG: TableStateConfig = {
  multiKeys: ["state"],
  singleKeys: ["run"],
  sortKeys: ["created", "name", "run", "state", "saved"],
  defaultSort: { key: "created", order: "desc" },
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100],
  quickViews: [
    { id: "all", params: {} },
    { id: "running", params: { state: ["running", "starting"] } },
    { id: "stopped", params: { state: ["stopped", "none"] } },
  ],
};

const ROW_CLASS =
  "cursor-pointer outline-none transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

const COL_COUNT = 7;

/** The run page's Notebooks tab, opening this notebook on arrival. */
export function openHref(notebook: Notebook): string {
  return `/runs/${encodeURIComponent(notebook.run_id)}?tab=notebooks&notebook=${encodeURIComponent(notebook.notebook_id)}`;
}

function runHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}?tab=notebooks`;
}

const STATE_ORDER: Record<LabState, number> = { running: 0, starting: 1, stopped: 2, none: 3 };

function compare(a: Notebook, b: Notebook, key: string): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "run":
      return a.run_id.localeCompare(b.run_id);
    case "state":
      return STATE_ORDER[labState(a)] - STATE_ORDER[labState(b)];
    case "saved":
      return (a.saved_at ?? "").localeCompare(b.saved_at ?? "");
    default:
      return a.created_at.localeCompare(b.created_at);
  }
}

export function WorkflowsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const table = useTableState(WORKFLOWS_TABLE_CONFIG, "/workflows");
  const { state, activeQuickViewId } = table;
  const query = useAllNotebooks();
  const all = useMemo(() => query.data ?? [], [query.data]);

  /** The notebook an action is running on, and what the button says meanwhile. */
  const [busy, setBusy] = useState<{ id: string; text: string } | null>(null);
  /** The notebook whose Delete was clicked once; a second click removes it. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    (runId: string) => {
      void queryClient.invalidateQueries({ queryKey: keys.notebooks.all });
      void queryClient.invalidateQueries({ queryKey: keys.runs.notebooks(runId) });
    },
    [queryClient],
  );

  /* One shape for every action: mark the row busy, call, say what happened, re-read. The
     list is re-read even after a failure, because a Portal that refused may still have
     changed the lab's state on the way. */
  const act = useCallback(
    (
      notebook: Notebook,
      text: string,
      call: () => Promise<unknown>,
      done: string,
      failed: string,
    ) => {
      setConfirming(null);
      setBusy({ id: notebook.notebook_id, text });
      setError(null);
      void (async () => {
        try {
          await call();
          toast.success(done);
        } catch (caught: unknown) {
          setError(caught instanceof ApiError ? caught.message : failed);
        } finally {
          setBusy(null);
          refresh(notebook.run_id);
        }
      })();
    },
    [refresh],
  );

  const start = (notebook: Notebook) =>
    act(
      notebook,
      "Starting…",
      () => openNotebook(notebook.run_id, notebook.notebook_id),
      `QuixLab on ${notebook.name} is starting.`,
      "The QuixLab could not be started",
    );

  const stop = (notebook: Notebook) =>
    act(
      notebook,
      "Stopping…",
      () => stopNotebook(notebook.run_id, notebook.notebook_id),
      `QuixLab on ${notebook.name} stopped.`,
      "The QuixLab could not be stopped",
    );

  /* Delete asks twice on the same button rather than in a dialog: the first click arms it,
     the second removes the notebook and this viewer's lab on it. */
  const remove = (notebook: Notebook) => {
    if (confirming !== notebook.notebook_id) {
      setConfirming(notebook.notebook_id);
      return;
    }
    act(
      notebook,
      "Deleting…",
      () => deleteNotebook(notebook.run_id, notebook.notebook_id),
      `${notebook.name} deleted.`,
      "The notebook could not be deleted",
    );
  };

  const counts = useMemo(() => {
    const out: Record<LabState, number> = { running: 0, starting: 0, stopped: 0, none: 0 };
    for (const notebook of all) out[labState(notebook)] += 1;
    return out;
  }, [all]);

  const shown = useMemo(() => {
    const states = (state.multi.state ?? []) as LabState[];
    const q = state.q.trim().toLowerCase();
    const rows = all.filter((notebook) => {
      if (states.length > 0 && !states.includes(labState(notebook))) return false;
      if (state.single.run !== undefined && notebook.run_id !== state.single.run) return false;
      if (q.length > 0) {
        const hay = `${notebook.name} ${notebook.run_id} ${notebook.created_by}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const key = state.sort?.key ?? "created";
    const dir = state.sort?.order === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => compare(a, b, key) * dir);
  }, [all, state]);

  const total = shown.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const rows = shown.slice((page - 1) * state.pageSize, page * state.pageSize);

  const quickViews: readonly QuickView[] = useMemo(
    () => [
      { id: "all", label: "All", count: query.data ? all.length : undefined },
      {
        id: "running",
        label: "Running",
        count: query.data ? counts.running + counts.starting : undefined,
      },
      {
        id: "stopped",
        label: "Stopped",
        count: query.data ? counts.stopped + counts.none : undefined,
      },
    ],
    [query.data, all.length, counts],
  );

  const pills = useMemo<readonly FilterPill[]>(() => {
    const list: FilterPill[] = [];
    for (const value of state.multi.state ?? []) {
      list.push({
        id: `state:${value}`,
        group: "State",
        label: STATE_LABEL[value as LabState] ?? value,
        onRemove: () => table.toggleFilterValue("state", value),
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
        title="Workflows"
        sub="Every QuixLab notebook of every test run. Open takes you to the notebook inside its run; Start warms your QuixLab on it, Stop halts it, Delete forgets it."
      />

      <ToolbarRow>
        <QuickViewSegment
          views={quickViews}
          activeId={activeQuickViewId}
          onSelect={table.setQuickView}
          aria-label="Workflow quick views"
        />
        <ToolbarDivider />
        <TableSearchInput
          value={state.q}
          onDebouncedChange={table.setQ}
          placeholder="Filter notebooks…"
        />
      </ToolbarRow>

      <div className="mb-2.5" />

      <ActiveFilterPills pills={pills} onClearAll={table.clearAll} />

      <Panel className="flex min-h-0 flex-1 flex-col">
        {error !== null && (
          <p role="alert" className="border-b border-line-2 px-4 py-2 text-[0.78rem] text-ink-3">
            {error}
          </p>
        )}
        <TableScrollArea>
          <table aria-label="Workflows" className="w-full">
            <thead>
              <tr>
                <SortableTh
                  label="Notebook"
                  sortKey="name"
                  active={state.sort}
                  onSort={(key) => table.setSort(key, "asc")}
                />
                <SortableTh
                  label="Run"
                  sortKey="run"
                  active={state.sort}
                  onSort={(key) => table.setSort(key, "asc")}
                />
                <th>Created by</th>
                <SortableTh
                  label="Created"
                  sortKey="created"
                  active={state.sort}
                  onSort={(key) => table.setSort(key, "desc")}
                  numeric
                />
                <SortableTh
                  label="Saved"
                  sortKey="saved"
                  active={state.sort}
                  onSort={(key) => table.setSort(key, "desc")}
                  numeric
                />
                <SortableTh
                  label="QuixLab"
                  sortKey="state"
                  active={state.sort}
                  onSort={(key) => table.setSort(key, "asc")}
                />
                <th className="w-64">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {query.isPending && <LoadingRows rows={5} cols={COL_COUNT} />}
              {query.isError && (
                <tr>
                  <td colSpan={COL_COUNT}>
                    <ErrorState
                      message="Could not read the notebooks."
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
                    No notebooks yet. Open a test run and choose Open in → New QuixLab notebook.
                  </td>
                </tr>
              )}
              {rows.map((notebook) => {
                const lab = labState(notebook);
                const mine = busy !== null && busy.id === notebook.notebook_id;
                const up = lab === "running" || lab === "starting";
                const armed = confirming === notebook.notebook_id;
                return (
                  <tr
                    key={notebook.notebook_id}
                    className={ROW_CLASS}
                    onClick={() => router.push(runHref(notebook.run_id))}
                  >
                    <td className="max-w-[22rem] truncate font-medium text-ink-1">
                      <Link
                        href={openHref(notebook)}
                        onClick={(e) => e.stopPropagation()}
                        title={notebook.name}
                      >
                        {notebook.name}
                      </Link>
                    </td>
                    <td className="font-mono text-[0.72rem] whitespace-nowrap">
                      <Link
                        href={runHref(notebook.run_id)}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {notebook.run_id}
                      </Link>
                    </td>
                    <td className="text-ink-2">{notebook.created_by}</td>
                    <td className="text-right font-mono text-[0.72rem] whitespace-nowrap">
                      {formatTime(notebook.created_at)}
                    </td>
                    <td className="text-right font-mono text-[0.72rem] whitespace-nowrap">
                      {notebook.saved_at ? formatTime(notebook.saved_at) : "—"}
                    </td>
                    <td>
                      <ToneBadge tone={STATE_TONE[lab]} dot>
                        {mine ? busy.text : STATE_LABEL[lab]}
                      </ToneBadge>
                    </td>
                    <td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <span className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="font-semibold"
                          disabled={busy !== null}
                          aria-label={`Open ${notebook.name}`}
                          onClick={() => router.push(openHref(notebook))}
                        >
                          Open
                        </Button>
                        {up ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="font-semibold"
                            disabled={busy !== null}
                            aria-busy={mine}
                            aria-label={`Stop ${notebook.name}`}
                            title="Stop your QuixLab on this notebook; the notebook keeps every edit"
                            onClick={() => stop(notebook)}
                          >
                            {mine ? busy.text : "Stop"}
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="font-semibold"
                            disabled={busy !== null}
                            aria-busy={mine}
                            aria-label={`Start ${notebook.name}`}
                            title="Start your QuixLab on this notebook without opening it"
                            onClick={() => start(notebook)}
                          >
                            {mine ? busy.text : "Start"}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className={cn(
                            "font-semibold",
                            armed && "text-red hover:border-red-border hover:bg-red-bg hover:text-red",
                          )}
                          disabled={busy !== null}
                          aria-label={
                            armed ? `Confirm deleting ${notebook.name}` : `Delete ${notebook.name}`
                          }
                          title="Removes the notebook and your QuixLab on it; its files stay in storage"
                          onClick={() => remove(notebook)}
                          onBlur={() => {
                            if (armed) setConfirming(null);
                          }}
                        >
                          {armed ? "Sure?" : "Delete"}
                        </Button>
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
