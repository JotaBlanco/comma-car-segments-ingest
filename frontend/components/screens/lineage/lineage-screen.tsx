"use client";

import Link from "next/link";
import { Crumb, Crumbs } from "@/components/shared/crumbs";
import { ErrorState } from "@/components/shared/error-state";
import { SourceBadge } from "@/components/shared/source-badge";
import { ToneBadge } from "@/components/shared/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { formatArrival, formatBytes, formatInt } from "@/lib/format";
import { useRunLineage } from "@/lib/hooks";
import type { LineageResponse } from "@/types";
import { Connector, MissingNodeCard, NodeCard, Rail } from "./node-card";

function ProvenanceRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-[0.68rem]">
      <span className="w-[92px] flex-none text-ink-3">{term}</span>
      <span className="font-mono text-[0.68rem]">{children}</span>
    </div>
  );
}

function LineageFlow({ data }: { data: LineageResponse }) {
  const { work_order: workOrder, definition, run, files, results } = data;
  const filenameById = new Map(files.map((file) => [file.file_id, file.filename]));

  return (
    <div className="flex flex-col items-center">
      {workOrder !== null ? (
        <NodeCard
          label="Work order"
          badge={<SourceBadge source={workOrder.source} />}
          title={workOrder.wo_id}
          sub={`${workOrder.title} · ${workOrder.project}`}
          href={`/work-orders/${encodeURIComponent(workOrder.wo_id)}`}
        />
      ) : (
        <MissingNodeCard label="Work order" />
      )}
      <Connector />
      {definition !== null ? (
        <NodeCard
          label="Test definition"
          badge={<SourceBadge source={definition.source} />}
          title={definition.td_id}
          sub={definition.title}
          href={`/definitions/${encodeURIComponent(definition.td_id)}`}
        />
      ) : (
        <MissingNodeCard label="Test definition" />
      )}
      <Connector />
      <NodeCard
        label="Test run"
        badge={<ToneBadge tone="neutral">{`${run.rig_id} / ${run.test_cell ?? "—"}`}</ToneBadge>}
        title={run.run_id}
        sub={`Registered ${formatArrival(run.first_data_at)} · ${run.file_count} files · ${formatInt(run.signal_count)} signals`}
        href={`/runs/${encodeURIComponent(run.run_id)}`}
      />
      {files.length > 0 && (
        <>
          <Connector />
          <Rail />
          {/* The row wraps. A run with many files then keeps readable cards
              instead of one row of slivers. */}
          <div className="flex w-full flex-wrap justify-center gap-3">
            {files.map((file) => (
              <div
                key={file.file_id}
                className="flex min-w-[168px] flex-1 basis-[168px] flex-col items-center"
              >
                <Connector className="h-4" />
                <NodeCard
                  label="File"
                  badge={<ToneBadge tone="neutral">{file.source_system}</ToneBadge>}
                  title={file.filename}
                  href={`/files/${encodeURIComponent(file.file_id)}`}
                  className="w-full px-3.5 py-[11px] [&>span]:text-[0.72rem]"
                  sub={
                    <span className="font-mono text-[0.66rem]">
                      {formatBytes(file.size_bytes)} · {file.signal_count} signals
                    </span>
                  }
                />
                {/* The tail below a file only exists to reach the processed
                    results. A run with no result has nothing to reach, so
                    drawing it leaves a line hanging off the bottom of the
                    chain and reads as a node that failed to load. */}
                {results.length > 0 && <Connector className="h-4" />}
              </div>
            ))}
          </div>
          {results.length > 0 && <Rail />}
        </>
      )}
      {results.map((result) => (
        <div key={result.result_id} className="flex flex-col items-center">
          <Connector />
          <NodeCard
            label="Processed result"
            badge={
              result.provenance_status === "verified" ? (
                <ToneBadge tone="green" dot>
                  Verified
                </ToneBadge>
              ) : (
                <ToneBadge tone="red" dot>
                  Flagged
                </ToneBadge>
              )
            }
            title={result.name}
            sub={`Written back via registry API · ${formatArrival(result.provenance.produced_at)}`}
            className="w-[440px] [&>span]:text-[0.8rem]"
          >
            <div className="mt-2.5 rounded-[5px] border border-line-2 bg-surface-2 px-3 py-[9px]">
              <div className="mb-1.5 text-[0.58rem] font-semibold tracking-[0.09em] text-ink-3 uppercase">
                Provenance — mandatory
              </div>
              <ProvenanceRow term="tool">
                {result.provenance.tool} {result.provenance.tool_version}
              </ProvenanceRow>
              <ProvenanceRow term="parameters">{result.provenance.parameters}</ProvenanceRow>
              <ProvenanceRow term="produced by">{result.provenance.produced_by}</ProvenanceRow>
              <ProvenanceRow term="input files">
                {result.provenance.input_file_ids
                  .map((fileId) => filenameById.get(fileId) ?? fileId)
                  .join(" · ")}
              </ProvenanceRow>
            </div>
          </NodeCard>
        </div>
      ))}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col items-center">
      <Skeleton className="h-[76px] w-[360px]" />
      <Connector />
      <Skeleton className="h-[76px] w-[360px]" />
      <Connector />
      <Skeleton className="h-[76px] w-[360px]" />
      <Connector />
      <div className="flex w-full gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-[70px] flex-1" />
        ))}
      </div>
      <Connector />
      <Skeleton className="h-[180px] w-[440px]" />
    </div>
  );
}

export function LineageScreen({ runId }: { runId: string }) {
  const lineageQuery = useRunLineage(runId);

  return (
    <div>
      <Crumbs>
        <Crumb type="Registry" href="/runs">
          Runs
        </Crumb>
        <Crumb type="Run" href={`/runs/${encodeURIComponent(runId)}`}>
          {runId}
        </Crumb>
        <Crumb type="View" current>
          Lineage
        </Crumb>
      </Crumbs>

      <div className="mb-[22px] flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[1.45rem] font-bold tracking-[-0.02em]">Lineage — {runId}</h1>
          <div className="mt-0.5 text-ink-3">
            Every artefact navigable from any other — the chain survives storage migration and
            re-processing.
          </div>
        </div>
        <div className="max-w-[220px] flex-none pb-0.5 text-right text-[0.7rem] text-ink-3">
          Re-processing creates a <b className="text-ink-2">new result version</b> — an existing
          result is never overwritten.
        </div>
      </div>

      {lineageQuery.isPending && <LoadingSkeleton />}
      {lineageQuery.isError &&
        (lineageQuery.error instanceof ApiError && lineageQuery.error.status === 404 ? (
          <div className="py-16 text-center">
            <div className="font-mono text-[0.9rem] font-semibold">Run not found</div>
            <div className="mt-1 text-[0.78rem] text-ink-3">
              No test run <span className="font-mono">{runId}</span> in the registry.
            </div>
            <Link
              href="/runs"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}
            >
              Back to runs
            </Link>
          </div>
        ) : (
          <ErrorState
            message="Could not load lineage for this run."
            onRetry={() => void lineageQuery.refetch()}
          />
        ))}
      {lineageQuery.isSuccess && <LineageFlow data={lineageQuery.data} />}
    </div>
  );
}
