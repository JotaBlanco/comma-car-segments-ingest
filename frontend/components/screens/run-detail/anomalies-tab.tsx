"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { TableScrollArea } from "@/components/shared/panel";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { lakeTable } from "@/lib/explore/lake-schema";
import { formatTime } from "@/lib/format";
import { useRunSnippets } from "@/lib/hooks";
import { issueHref } from "@/lib/snippets/issue-link";
import {
  filterSnippets,
  formatFrame,
  formatSpan,
  searchSnippets,
  SNIPPET_STATES,
  snippetFacets,
  snippetFrame,
  snippetNote,
  snippetSource,
  snippetTags,
  sortSnippets,
  type SnippetSortKey,
  type SnippetState,
  type SnippetTags,
  type SortDir,
} from "@/lib/snippets/anomalies";
import type { DataSnippet } from "@/types";
import {
  IssueOpenButtons,
  KindBadge,
  STATE_LABEL,
  StateBadge,
} from "@/components/screens/issues/issue-detail";

const PAGE_SIZES = [10, 20, 50] as const;

const SORT_LABEL: Record<SnippetSortKey, string> = {
  updated: "Updated",
  name: "Name",
  kind: "Kind",
  state: "State",
  partitions: "Partitions",
};

function SortIcon({ dir }: { dir: SortDir }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={dir === "desc" ? "M12 5v14M5 12l7 7 7-7" : "M12 19V5M5 12l7-7 7 7"} />
    </svg>
  );
}

const selectClass =
  "h-8 rounded-md border border-line bg-surface px-2 text-[0.8rem] text-ink-1 outline-none focus-visible:border-primary";

/** `ai_3_store · ai_3`: the store the issue belongs to and the cell that found it. */
function foundBy(t: SnippetTags): string {
  return [t.store, t.analysis].filter(Boolean).join(" · ");
}

/* ──────────────────────────── the list ──────────────────────────── */

function SnippetList({ snippets, runId }: { snippets: DataSnippet[]; runId: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SnippetSortKey>("updated");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(20);
  const [state, setState] = useState<SnippetState | "all">("all");
  const [kind, setKind] = useState<string>("all");
  const [store, setStore] = useState<string>("all");
  const facets = useMemo(() => snippetFacets(snippets), [snippets]);
  const shown = useMemo(
    () =>
      sortSnippets(
        searchSnippets(filterSnippets(snippets, { state, kind, store }), query),
        sortKey,
        sortDir,
      ),
    [snippets, query, state, kind, store, sortKey, sortDir],
  );
  const totalPages = Math.max(1, Math.ceil(shown.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = shown.slice((safePage - 1) * pageSize, safePage * pageSize);
  const toggleSort = (key: SnippetSortKey) => {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };
  const th = (key: SnippetSortKey, label: string, className?: string) => (
    <TableHead className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-ink-1"
        onClick={() => toggleSort(key)}
      >
        {label}
        {sortKey === key && <SortIcon dir={sortDir} />}
      </button>
    </TableHead>
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <TableSearchInput
          value={query}
          onDebouncedChange={(v) => {
            setQuery(v);
            setPage(1);
          }}
          placeholder="Search name, note, SQL, partitions…"
          className="w-80"
        />
        <label className="flex items-center gap-2 text-[0.78rem] text-ink-3">
          State
          <select
            className={selectClass}
            value={state}
            onChange={(e) => {
              setState(e.target.value as SnippetState | "all");
              setPage(1);
            }}
            aria-label="Filter snippets by state"
          >
            <option value="all">All</option>
            {SNIPPET_STATES.map((k) => (
              <option key={k} value={k}>
                {STATE_LABEL[k]} ({facets.states[k]})
              </option>
            ))}
          </select>
        </label>
        {facets.kinds.length > 1 && (
          <label className="flex items-center gap-2 text-[0.78rem] text-ink-3">
            Kind
            <select
              className={selectClass}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPage(1);
              }}
              aria-label="Filter snippets by kind"
            >
              <option value="all">All</option>
              {facets.kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
        {facets.stores.length > 1 && (
          <label className="flex items-center gap-2 text-[0.78rem] text-ink-3">
            Store
            <select
              className={selectClass}
              value={store}
              onChange={(e) => {
                setStore(e.target.value);
                setPage(1);
              }}
              aria-label="Filter snippets by data store"
            >
              <option value="all">All</option>
              {facets.stores.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-[0.78rem] text-ink-3">
          Sort
          <select
            className={selectClass}
            value={sortKey}
            onChange={(e) => toggleSort(e.target.value as SnippetSortKey)}
            aria-label="Sort snippets by"
          >
            {(Object.keys(SORT_LABEL) as SnippetSortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md border border-line hover:bg-muted"
            onClick={() => setSortDir(sortDir === "asc" ? "desc" : "asc")}
            aria-label={sortDir === "asc" ? "Sort descending" : "Sort ascending"}
          >
            <SortIcon dir={sortDir} />
          </button>
        </label>
        <span className="ml-auto font-mono text-[0.72rem] text-ink-3">
          {shown.length === snippets.length
            ? `${snippets.length} snippets`
            : `${shown.length} of ${snippets.length} snippets`}
          {" · "}run_id={runId}
        </span>
      </div>
      <TableScrollArea className="max-h-[max(20rem,70dvh)]">
        <Table aria-label="Data snippets of this run">
          <TableHeader>
            <TableRow>
              {th("name", "Name")}
              <TableHead>Note</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Found by</TableHead>
              {th("partitions", "Partitions", "text-right")}
              {th("updated", "Updated", "text-right")}
              <TableHead className="text-right">
                <span className="sr-only">Open in</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={10}>
                  <EmptyState
                    title="No snippet matches"
                    message="Try another word or widen the filters: the search reads names, notes, SQL and partitions."
                  />
                </TableCell>
              </TableRow>
            )}
            {rows.map((s) => {
              const frame = snippetFrame(s);
              const src = snippetSource(s);
              const t = snippetTags(s);
              return (
                <TableRow
                  key={s.id}
                  className="cursor-pointer"
                  onClick={() => router.push(issueHref(s.id, runId))}
                >
                  <TableCell className="max-w-[24rem] truncate font-medium text-ink-1">
                    <Link
                      href={issueHref(s.id, runId)}
                      onClick={(e) => e.stopPropagation()}
                      title={s.name}
                    >
                      {s.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[26rem] truncate text-ink-2">
                    {snippetNote(s.markdown) || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-[0.72rem] text-ink-2">
                    {[src.scope, src.signal].filter(Boolean).join(" · ") || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-[0.72rem] text-ink-2 whitespace-nowrap">
                    {frame ? `${formatFrame(frame).split(" → ")[0].replace(/ Z$/, "")} · ${formatSpan(frame)}` : "—"}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1">
                      <KindBadge kind={t.kind} />
                      {t.reference && (
                        <Badge variant="secondary" title="A plain slice of the source table">
                          reference
                        </Badge>
                      )}
                      {t.other.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StateBadge state={t.state} />
                  </TableCell>
                  <TableCell className="font-mono text-[0.72rem] text-ink-2 whitespace-nowrap">
                    {foundBy(t) || "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[0.72rem]">
                    {s.partitions.length}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[0.72rem] whitespace-nowrap">
                    {s.updated_at ? formatTime(s.updated_at) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="flex items-center justify-end gap-1">
                      <IssueOpenButtons snippet={s} runId={runId} iconOnly />
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableScrollArea>
      <TablePager
        page={safePage}
        pageSize={pageSize}
        total={shown.length}
        totalPages={totalPages}
        onPageChange={setPage}
        onPageSizeChange={(n: number) => {
          setPageSize(PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number]) ? n : 20);
          setPage(1);
        }}
      />
    </>
  );
}

/* ───────────────────────────── the tab ───────────────────────────── */

/**
 * The run's issues: the lake's data snippets over the run's table, narrowed to this run
 * (QuixLab writes one per finding). A list to search, filter and sort; each one opens on
 * its own page, which knows this tab sent it and offers the way back.
 */
export function AnomaliesTab({
  runId,
  onCountChange,
}: {
  runId: string;
  /** Tells the tab strip how many were found, once the lake has answered. */
  onCountChange?: (count: number) => void;
}) {
  const query = useRunSnippets(runId);
  const snippets = query.data?.snippets ?? [];
  const found = query.data ? snippets.length : null;
  useEffect(() => {
    if (found !== null) onCountChange?.(found);
  }, [found, onCountChange]);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[0.7rem] font-semibold tracking-wider text-ink-3 uppercase">
        Data snippets · {lakeTable()}
        <span className="ml-auto font-mono normal-case tracking-normal text-ink-3">
          run_id={runId}
        </span>
      </div>
      {query.isPending && (
        <Table aria-label="Loading data snippets">
          <TableBody>
            <LoadingRows rows={5} cols={6} />
          </TableBody>
        </Table>
      )}
      {query.isError && (
        <ErrorState
          message="Could not read the run's data snippets from the lake."
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && snippets.length === 0 && (
        <EmptyState
          title="No issues recorded"
          message="Nothing in the lake's data snippets names this run yet. QuixLab adds one per finding it makes."
        />
      )}
      {query.data && snippets.length > 0 && <SnippetList snippets={snippets} runId={runId} />}
    </div>
  );
}
