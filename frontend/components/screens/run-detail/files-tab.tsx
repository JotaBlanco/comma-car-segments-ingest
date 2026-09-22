"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DownloadButton } from "@/components/screens/files/download-button";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { TablePager } from "@/components/shared/table-pager";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/lib/format";
import { useRunFiles } from "@/lib/hooks";

// A source system the map does not know prints its own name, never an empty word.
const sourceLabel: Record<string, string | undefined> = {
  TAS: "TAS acquisition",
  INCA: "INCA export",
  ifile: "sidecar",
};

const shortChecksum = (sha: string) =>
  `sha256:${sha.slice(0, 4)}…${sha.slice(-4)}`;

const PAGE_SIZES = [20, 50, 100, 200] as const;

export function FilesTab({ runId }: { runId: string }) {
  const router = useRouter();
  /* A page at a time. One synthetic sortie registers 720 chunk files, and this
     tab refetches every ten seconds — the whole set was a heavy answer to a
     question a screenful of rows asks. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(20);
  const filesQuery = useRunFiles(runId, { page, page_size: pageSize });
  const items = filesQuery.data?.items ?? [];
  const total = filesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <Table aria-label="Files of this run">
        <TableHeader>
          <TableRow>
            <TableHead>File</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead className="text-right">Signals</TableHead>
            <TableHead>Checksum</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-9 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filesQuery.isPending && <LoadingRows rows={3} cols={7} />}
          {filesQuery.isError && (
            <TableRow>
              <TableCell colSpan={7} className="p-0!">
                <ErrorState
                  message="Could not load files for this run."
                  onRetry={() => void filesQuery.refetch()}
                />
              </TableCell>
            </TableRow>
          )}
          {filesQuery.isSuccess && items.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="p-0!">
                <EmptyState
                  title="No files"
                  message="No files registered against this run yet."
                />
              </TableCell>
            </TableRow>
          )}
          {items.map((file) => (
            <TableRow
              key={file.file_id}
              className="cursor-pointer"
              onClick={() =>
                router.push(`/files/${encodeURIComponent(file.file_id)}`)
              }
            >
              <TableCell>
                <Link
                  href={`/files/${encodeURIComponent(file.file_id)}`}
                  className="font-mono text-[0.78rem]"
                  onClick={(event) => event.stopPropagation()}
                >
                  {file.filename}
                </Link>
                <div className="mt-px text-[0.72rem] text-ink-3">
                  {file.format} ·{" "}
                  {sourceLabel[file.source_system] ?? file.source_system}
                </div>
              </TableCell>
              <TableCell>
                <ToneBadge tone="neutral">{file.source_system}</ToneBadge>
              </TableCell>
              <TableCell className="text-right">
                {formatBytes(file.size_bytes)}
              </TableCell>
              <TableCell className="text-right">{file.signal_count}</TableCell>
              <TableCell>
                <span className="font-mono text-[0.72rem] text-ink-3">
                  {shortChecksum(file.checksum_sha256)}
                </span>
              </TableCell>
              <TableCell>
                <StatusBadge status={file.status} />
              </TableCell>
              <TableCell className="w-9 text-right">
                <DownloadButton
                  fileId={file.file_id}
                  filename={file.filename}
                  sizeBytes={file.size_bytes}
                  quarantined={file.status === "quarantined"}
                  variant="row"
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {filesQuery.isSuccess && total > 0 && (
        <TablePager
          page={page}
          pageSize={pageSize}
          total={total}
          totalPages={totalPages}
          onPageChange={setPage}
          onPageSizeChange={(size: number) => {
            setPageSize(
              PAGE_SIZES.includes(size as (typeof PAGE_SIZES)[number])
                ? size
                : 20,
            );
            setPage(1);
          }}
        />
      )}
    </>
  );
}
