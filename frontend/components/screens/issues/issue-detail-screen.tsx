"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Crumb, Crumbs } from "@/components/shared/crumbs";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { LoadingRows } from "@/components/shared/loading-rows";
import { Panel } from "@/components/shared/panel";
import { Table, TableBody } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import { useAllSnippets, useRun } from "@/lib/hooks";
import { snippetNote, snippetRuns } from "@/lib/snippets/anomalies";
import { cn } from "@/lib/utils";
import { IssueData, IssueGeneral, IssueOpenButtons, IssueStateControl } from "./issue-detail";

/**
 * One issue, on a page of its own.
 *
 * It is reached from the Issues list and from a run's Issues tab, and it says which one it
 * came from: `from` names the run whose tab opened it, so the back control returns there
 * rather than to a list the person never used. The crumbs carry the chain above it — the
 * work order, the definition and the test run the issue belongs to — so the parent test is
 * one click away.
 */
export function IssueDetailScreen({ issueId, from }: { issueId: number; from: string | null }) {
  const query = useAllSnippets();
  const snippet = (query.data?.snippets ?? []).find((s) => s.id === issueId) ?? null;
  const runs = snippet === null ? [] : snippetRuns(snippet);
  const runId = runs[0] ?? null;
  const run = useRun(runId ?? "");
  const [page, setPage] = useState<"general" | "data">("general");

  const backHref = from !== null ? `/runs/${encodeURIComponent(from)}?tab=anomalies` : "/issues";
  const backLabel = from !== null ? "Back to the run's issues" : "Back to issues";

  const pageClass = (on: boolean) =>
    cn(
      "px-3 py-2 text-[0.8rem] font-semibold border-b-2 -mb-px",
      on ? "border-primary text-primary" : "border-transparent text-ink-3 hover:text-ink-2",
    );

  return (
    <FullHeightPage>
      <Crumbs>
        {run.data?.work_order_id ? (
          <Crumb type="WO" href={`/work-orders/${encodeURIComponent(run.data.work_order_id)}`}>
            {run.data.work_order_id}
          </Crumb>
        ) : null}
        {run.data?.definition_id ? (
          <Crumb type="DEF" href={`/definitions/${encodeURIComponent(run.data.definition_id)}`}>
            {run.data.definition_id}
          </Crumb>
        ) : null}
        {runId !== null ? (
          <Crumb type="RUN" href={`/runs/${encodeURIComponent(runId)}`}>
            {runId}
          </Crumb>
        ) : null}
        <Crumb type="ISSUE" current missing={snippet === null}>
          {snippet === null ? String(issueId) : snippet.name}
        </Crumb>
      </Crumbs>

      {query.isPending && (
        <Panel>
          <Table aria-label="Loading the issue">
            <TableBody>
              <LoadingRows rows={4} cols={2} />
            </TableBody>
          </Table>
        </Panel>
      )}
      {query.isError && (
        <ErrorState
          message="Could not read the lake's data snippets."
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isSuccess && snippet === null && (
        <EmptyState
          title="No such issue"
          message="Nothing in the lake's data snippets carries this id. It may have been deleted in QuixLab."
        />
      )}

      {snippet !== null && (
        <Panel className="flex min-h-0 flex-1 flex-col">
          {/* One row: back, the name, the pages, the state and where it opens. */}
          <div className="flex items-center gap-3 border-b border-line px-4 py-2">
            <Link
              href={backHref}
              className={cn(buttonVariants({ variant: "outline", size: "icon" }), "shrink-0")}
              aria-label={backLabel}
              title={backLabel}
            >
              <ArrowLeft />
            </Link>
            <span className="min-w-0 flex-1 truncate font-semibold text-ink-1" title={snippet.name}>
              {snippet.name}
            </span>
            <div className="ml-2 flex shrink-0" role="tablist" aria-label="Issue pages">
              <button
                type="button"
                role="tab"
                aria-selected={page === "general"}
                className={pageClass(page === "general")}
                onClick={() => setPage("general")}
              >
                General
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={page === "data"}
                className={pageClass(page === "data")}
                onClick={() => setPage("data")}
              >
                Data
              </button>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              <IssueStateControl snippet={snippet} />
              <IssueOpenButtons snippet={snippet} runId={runId} />
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {page === "general" ? (
              <>
                {runId !== null && (
                  <div className="flex flex-wrap items-center gap-3 border-b border-line-2 px-4 py-2 text-[0.8rem] text-ink-2">
                    <span className="text-ink-3">Test run</span>
                    <Link
                      href={`/runs/${encodeURIComponent(runId)}`}
                      className="font-mono text-[0.78rem] hover:underline"
                    >
                      {runId}
                    </Link>
                    {run.data && (
                      <>
                        <span className="text-ink-3">·</span>
                        <span className="font-mono text-[0.72rem] text-ink-3">
                          {run.data.rig_id}
                          {run.data.test_cell === null ? "" : ` / ${run.data.test_cell}`}
                        </span>
                        <span className="font-mono text-[0.72rem] text-ink-3">
                          {formatTime(run.data.first_data_at)}
                        </span>
                      </>
                    )}
                    {runs.length > 1 && (
                      <span className="text-[0.72rem] text-ink-3" title={runs.join("\n")}>
                        and {runs.length - 1} more run{runs.length === 2 ? "" : "s"}
                      </span>
                    )}
                    <span className="flex-1" />
                    <span className="max-w-[48ch] truncate text-[0.78rem] text-ink-3">
                      {snippetNote(snippet.markdown)}
                    </span>
                  </div>
                )}
                <IssueGeneral snippet={snippet} runId={runId} />
              </>
            ) : (
              <IssueData snippet={snippet} />
            )}
          </div>
        </Panel>
      )}
    </FullHeightPage>
  );
}
