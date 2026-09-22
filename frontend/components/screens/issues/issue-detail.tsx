"use client";

import { useState } from "react";
import { Activity, Check, ChevronDown, ChevronRight, Database, FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { MarkdownLite } from "@/components/shared/markdown-lite";
import { NewTabMark } from "@/components/shared/new-tab-mark";
import { TableScrollArea } from "@/components/shared/panel";
import { ToneBadge, type BadgeTone } from "@/components/shared/status-badge";
import { WorkbookMenu } from "@/components/shared/workbook-menu";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { lakeTable } from "@/lib/explore/lake-schema";
import { ftsConfigured, ftsSnippetUrl, openFts } from "@/lib/fts";
import { useSetIssueState, useSnippetData } from "@/lib/hooks";
import { openQuixLabNode, quixLabConfigured } from "@/lib/quixlab";
import {
  formatFrame,
  formatSpan,
  SNIPPET_STATES,
  snippetFrame,
  snippetSource,
  snippetTags,
  type SnippetState,
} from "@/lib/snippets/anomalies";
import { showValue, summarisePartitions } from "@/lib/snippets/partitions";
import { cn } from "@/lib/utils";
import type { DataSnippet } from "@/types";

/**
 * One issue, as every screen shows it: the run page's Issues tab, the Issues page's detail
 * and a workbook's side panel all read these. One reading of a snippet, so a badge and a
 * control never mean two different things in two places.
 */

const ROW_LIMITS = [100, 500, 1000] as const;

export const STATE_TONE: Record<SnippetState, BadgeTone> = {
  open: "amber",
  resolved: "green",
  closed: "neutral",
};

export const STATE_LABEL: Record<SnippetState, string> = {
  open: "Open",
  resolved: "Resolved",
  closed: "Closed",
};

/** The record's kind: `anomaly`, `gap`, `outlier`, ... as the analysis named it. */
export function KindBadge({ kind }: { kind: string }) {
  return (
    <Badge variant="outline" className="font-mono">
      {kind}
    </Badge>
  );
}

/** Where the engineer left the record: open needs attention, resolved is done, closed is muted. */
export function StateBadge({ state }: { state: SnippetState | null }) {
  if (state === null) return <span className="text-ink-3">—</span>;
  return (
    <ToneBadge tone={STATE_TONE[state]} dot>
      {STATE_LABEL[state]}
    </ToneBadge>
  );
}

/**
 * Move the issue to another state. The write goes to the lake's snippet, tags and note
 * together, the way QuixLab writes it, so QuixLab reads back what was set here.
 */
export function IssueStateControl({ snippet }: { snippet: DataSnippet }) {
  const state = snippetTags(snippet).state;
  const set = useSetIssueState();
  const label = state === null ? "Set state" : STATE_LABEL[state];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "font-semibold")}
        disabled={set.isPending}
        aria-label={`State: ${label}`}
        title="Move this issue to another state"
      >
        <StateBadge state={state} />
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>State</DropdownMenuLabel>
          {SNIPPET_STATES.map((next) => (
            <DropdownMenuItem
              key={next}
              onClick={() => {
                if (next === state) return;
                set.mutate(
                  { snippet, state: next },
                  {
                    onSuccess: () => toast(`${snippet.name} is ${STATE_LABEL[next].toLowerCase()}`),
                    onError: (error: unknown) =>
                      toast(
                        error instanceof Error
                          ? `Could not change the state: ${error.message}`
                          : "Could not change the state.",
                      ),
                  },
                );
              }}
            >
              {next === state ? <Check /> : <span className="size-4" aria-hidden="true" />}
              {STATE_LABEL[next]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Where this issue opens: a workbook, the Explorer, QuixLab, the station. */
export function IssueOpenButtons({
  snippet,
  runId,
  iconOnly = false,
}: {
  snippet: DataSnippet;
  runId: string | null;
  iconOnly?: boolean;
}) {
  const t = snippetTags(snippet);
  const frame = snippetFrame(snippet);
  const src = snippetSource(snippet);
  const fts = ftsConfigured() && runId !== null ? ftsSnippetUrl(runId, src.signal, frame) : null;
  const quixLab = quixLabConfigured();
  const signals = src.signal === null ? [] : [src.signal];
  return (
    <>
      {runId !== null && (
        <WorkbookMenu
          run={runId}
          signals={signals}
          frame={frame}
          issue={snippet.id}
          explore={{ run: runId, scope: src.scope, signal: src.signal, frame }}
          iconOnly={iconOnly}
          label={iconOnly ? `Open ${snippet.name} in a workbook` : "Open in a workbook"}
        />
      )}
      {quixLab && (
        <Button
          size={iconOnly ? "icon-xs" : "sm"}
          variant={iconOnly ? "ghost" : "outline"}
          className={iconOnly ? undefined : "font-semibold"}
          aria-label={`Open ${snippet.name} in QuixLab (opens a new tab)`}
          title="Open in QuixLab"
          onClick={(e) => {
            e.stopPropagation();
            openQuixLabNode(t.analysis, runId ?? "");
          }}
        >
          <FlaskConical />
          {!iconOnly && (
            <>
              Open in QuixLab <NewTabMark iconClassName="size-3 opacity-80" />
            </>
          )}
        </Button>
      )}
      {fts !== null && (
        <Button
          size={iconOnly ? "icon-xs" : "sm"}
          variant={iconOnly ? "ghost" : "outline"}
          className={iconOnly ? undefined : "font-semibold"}
          aria-label={`Open ${snippet.name} in the Flight Test Station (opens a new tab)`}
          title="Open in Flight Test Station"
          onClick={(e) => {
            e.stopPropagation();
            openFts(fts);
          }}
        >
          <Activity />
          {!iconOnly && (
            <>
              Open in the station <NewTabMark iconClassName="size-3 opacity-80" />
            </>
          )}
        </Button>
      )}
    </>
  );
}

/**
 * The snippet's folders as QuixLab's console shows them: the table, the levels every folder
 * shares as one row of chips, and a table of the levels that tell the folders apart.
 */
export function PartitionFolders({ partitions }: { partitions: readonly string[] }) {
  const s = summarisePartitions(partitions);
  const count = s.whole
    ? "whole table"
    : `${s.rows.length} ${s.rows.length === 1 ? "folder" : "folders"}`;
  const chip = (v: string, key: string) => (
    <span
      key={key}
      className="rounded-full border border-line bg-muted px-2.5 py-0.5 font-mono text-[0.72rem] text-ink-1"
      title={key}
    >
      {showValue(v)}
    </span>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[0.8rem]">
        <Database className="size-4 text-amber" aria-hidden="true" />
        <span className="font-mono font-semibold text-ink-1">{lakeTable()}</span>
        <span className="text-ink-3">{count}</span>
      </div>
      {s.whole && chip(`every row of ${lakeTable()}`, "root")}
      {s.shared.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          title={s.shared.map((x) => `${x.key}=${x.value}`).join(" / ")}
        >
          {s.shared.flatMap((x, i) => [
            chip(x.value, x.key),
            <span key={`${x.key}-sep`} className="text-ink-3" aria-hidden="true">
              {i < s.shared.length - 1 || s.columns.length > 0 ? "/" : ""}
            </span>,
          ])}
        </div>
      )}
      {s.rows.length > 0 && (
        <TableScrollArea className="max-h-[40dvh] rounded-md border border-line">
          <Table aria-label="Partition folders">
            <TableHeader>
              <TableRow>
                {s.columns.map((k) => (
                  <TableHead key={k} className="font-mono text-[0.72rem] uppercase">
                    {k}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.rows.slice(0, 200).map((r) => (
                <TableRow key={r.path} title={r.path}>
                  {s.columns.map((k) => (
                    <TableCell key={k} className="font-mono text-[0.78rem]">
                      {k in r.values ? showValue(r.values[k]) : <span className="text-ink-3">any</span>}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScrollArea>
      )}
      {s.rows.length > 200 && (
        <span className="text-[0.72rem] text-ink-3">… and {s.rows.length - 200} more</span>
      )}
    </div>
  );
}

const selectClass =
  "h-8 rounded-md border border-line bg-surface px-2 text-[0.8rem] text-ink-1 outline-none focus-visible:border-primary";

/** The issue's first rows, read from the lake by its own SQL. */
export function IssueData({ snippet }: { snippet: DataSnippet }) {
  const [limit, setLimit] = useState<number>(100);
  const data = useSnippetData(snippet.id, limit);
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2 text-[0.78rem] text-ink-3">
        First
        <select
          className={selectClass}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          aria-label="Rows to read"
        >
          {ROW_LIMITS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        rows
        {data.data && (
          <span className="font-mono">
            {" · "}
            {data.data.row_count} rows shown
          </span>
        )}
      </div>
      {data.isError && (
        <ErrorState
          message="Could not read the issue's rows from the lake."
          onRetry={() => void data.refetch()}
        />
      )}
      <TableScrollArea className="max-h-[60dvh] rounded-md border border-line">
        <Table aria-label={`Rows of ${snippet.name}`}>
          <TableHeader>
            <TableRow>
              {(data.data?.columns ?? []).map((c) => (
                <TableHead key={c} className="font-mono text-[0.72rem] whitespace-nowrap">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.isPending && <LoadingRows rows={8} cols={6} />}
            {data.data?.rows.map((row, i) => (
              <TableRow key={i}>
                {row.map((cell, j) => (
                  <TableCell key={j} className="font-mono text-[0.72rem] whitespace-nowrap">
                    {cell === "" ? "—" : cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {data.data && data.data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={Math.max(1, data.data.columns.length)}>
                  <EmptyState title="No rows" message="The issue's SQL selects nothing today." />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableScrollArea>
    </div>
  );
}

/** Everything the issue says: its note, what it names, its folders and its SQL. */
export function IssueGeneral({
  snippet,
  runId,
  className,
}: {
  snippet: DataSnippet;
  runId: string | null;
  className?: string;
}) {
  const frame = snippetFrame(snippet);
  const src = snippetSource(snippet);
  const t = snippetTags(snippet);
  const [sqlOpen, setSqlOpen] = useState(false);
  return (
    <div className={cn("flex flex-col gap-4 p-4", className)}>
      <div className="max-w-[80ch] rounded-lg border border-line bg-accent-soft/40 px-5 py-4 text-[0.85rem] leading-relaxed">
        <MarkdownLite text={snippet.markdown || "_No note._"} />
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[0.8rem]">
        <dt className="text-ink-3">Run</dt>
        <dd className="font-mono break-all">{runId ?? "—"}</dd>
        <dt className="text-ink-3">Source</dt>
        <dd className="font-mono">{[src.scope, src.signal].filter(Boolean).join(" · ") || "—"}</dd>
        <dt className="text-ink-3">Period</dt>
        <dd className="font-mono">{frame ? `${formatFrame(frame)} · ${formatSpan(frame)}` : "—"}</dd>
        <dt className="text-ink-3">Kind</dt>
        <dd>
          <span className="flex flex-wrap items-center gap-1">
            <KindBadge kind={t.kind} />
            {t.reference && (
              <Badge variant="secondary" title="A plain slice of the source table">
                reference
              </Badge>
            )}
          </span>
        </dd>
        <dt className="text-ink-3">State</dt>
        <dd>
          <StateBadge state={t.state} />
        </dd>
        {t.quixLab && (
          <>
            <dt className="text-ink-3">Found by</dt>
            <dd className="font-mono">
              {t.analysis ?? "—"}
              {t.store !== null && <span className="text-ink-3"> · store {t.store}</span>}
            </dd>
          </>
        )}
        <dt className="text-ink-3">Tags</dt>
        <dd>
          <span className="flex flex-wrap gap-1">
            {snippet.tags.length === 0 && "—"}
            {snippet.tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </span>
        </dd>
      </dl>
      <div>
        <div className="mb-2 text-[0.7rem] font-semibold tracking-wider text-ink-3 uppercase">
          Partitions
        </div>
        {snippet.partitions.length === 0 ? (
          <span className="text-ink-3">—</span>
        ) : (
          <PartitionFolders partitions={snippet.partitions} />
        )}
      </div>
      <div>
        <button
          type="button"
          className="mb-1 inline-flex items-center gap-1 text-[0.7rem] font-semibold tracking-wider text-ink-3 uppercase hover:text-ink-1"
          onClick={() => setSqlOpen(!sqlOpen)}
          aria-expanded={sqlOpen}
        >
          {sqlOpen ? (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden="true" />
          )}
          SQL
        </button>
        {sqlOpen && (
          <pre className="overflow-x-auto rounded-md border border-line bg-muted p-3 font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap">
            {snippet.sql}
          </pre>
        )}
      </div>
    </div>
  );
}
