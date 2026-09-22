"use client";

import Link from "next/link";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { WorkbookMenu } from "@/components/shared/workbook-menu";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { Panel, PanelHead } from "@/components/shared/panel";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatArrival } from "@/lib/format";
import type { RecentRun } from "@/types";

interface RecentRunsPanelProps {
  runs: RecentRun[] | undefined;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
}

export function RecentRunsPanel({ runs, isPending, isError, onRetry }: RecentRunsPanelProps) {
  return (
    <Panel>
      <PanelHead
        title="Recent test runs"
        action={
          <Link href="/runs" className="text-[0.75rem] font-semibold text-primary">
            View all
          </Link>
        }
      />
      <Table aria-label="Recent test runs">
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>Definition</TableHead>
            <TableHead>Rig</TableHead>
            <TableHead>Data arrived</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Open in</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isPending && <LoadingRows rows={5} cols={5} />}
          {isError && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="p-0!">
                <ErrorState onRetry={onRetry} />
              </TableCell>
            </TableRow>
          )}
          {runs !== undefined && runs.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="p-0!">
                <EmptyState message="No runs yet." />
              </TableCell>
            </TableRow>
          )}
          {runs?.map((run) => (
            <RowLink key={run.run_id} href={`/runs/${encodeURIComponent(run.run_id)}`}>
              <TableCell>
                <RowLinkLabel>
                  <span className="font-mono text-[0.78rem]">{run.run_id}</span>
                </RowLinkLabel>
                <div className="mt-px text-[0.72rem] text-ink-3">{run.description ?? "—"}</div>
              </TableCell>
              <TableCell>
                <span className="font-mono text-[0.78rem]">{run.definition_id ?? "—"}</span>
              </TableCell>
              <TableCell>
                <span className="font-mono text-[0.78rem]">{run.rig_id}</span>
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
    </Panel>
  );
}
