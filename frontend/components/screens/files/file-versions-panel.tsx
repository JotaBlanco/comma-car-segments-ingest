"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Link2, Plus } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Panel, PanelHead } from "@/components/shared/panel";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatArrival, formatBytes } from "@/lib/format";
import { useFileVersions } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { FileDetail, FileEntity } from "@/types";
import { DownloadButton } from "./download-button";
import { LifecycleBadge } from "./lifecycle-badge";
import { UploadVersionDialog } from "./upload-version-dialog";

interface FileVersionsPanelProps {
  file: FileDetail;
  className?: string;
}

/** The version number of one row. A row without the field is version 1. */
function versionOf(row: FileEntity): number {
  return row.version ?? 1;
}

/**
 * The permanent link to one version (FR-DM-102).
 *
 * Every version is its own file document with its own id, and
 * `/files/{file_id}` renders that one document. The link therefore names the
 * version, never the newest version of the chain: a later version mints a new
 * id and leaves this one untouched.
 */
export function versionLink(fileId: string, origin: string): string {
  return `${origin}/files/${encodeURIComponent(fileId)}`;
}

/** Copy the permanent link of one version to the clipboard. */
function CopyLinkButton({ row }: { row: FileEntity }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const link = versionLink(row.file_id, window.location.origin);
    try {
      // A browser refuses the clipboard outside a secure context, so the
      // failure branch still hands the person the link to copy by hand.
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success(`Copied the link to version ${versionOf(row)}`, { description: link });
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("This browser refused the clipboard. Copy the link by hand.", {
        description: link,
      });
    }
  };

  return (
    <button
      type="button"
      aria-label={`Copy link to version ${versionOf(row)} of ${row.filename}`}
      onClick={() => void copy()}
      className={cn(
        "inline-flex flex-none items-center gap-[5px] rounded-md border border-border bg-surface-2 px-[9px] py-[4px] text-[0.72rem] font-semibold text-ink-2 transition-colors",
        "hover:bg-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      )}
    >
      {copied ? (
        <Check className="size-[12px]" strokeWidth={2.6} />
      ) : (
        <Link2 className="size-[12px]" strokeWidth={2.2} />
      )}
      Copy link
    </button>
  );
}

/**
 * The version history of one file (FR-DM-103).
 *
 * `GET /files/{id}/versions` answers oldest first, so the panel reverses the
 * list and puts the newest version on top. Every row carries its own id, its
 * own checksum and its own download, because every version is a whole file
 * document. A new version never replaces an older one.
 *
 * Every lifecycle shows here, and a deleted version stays in the list: the
 * history is the audit trail of the file, so a gap would hide a step.
 */
export function FileVersionsPanel({ file, className }: FileVersionsPanelProps) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const versionsQuery = useFileVersions(file.file_id);
  const rows = [...(versionsQuery.data?.items ?? [])].sort(
    (left, right) => versionOf(right) - versionOf(left),
  );
  const newestId = rows.length > 0 ? rows[0].file_id : null;
  const lifecycle = file.lifecycle ?? "active";

  return (
    <Panel className={className}>
      <PanelHead
        title="Version history"
        action={
          <button
            type="button"
            disabled={lifecycle !== "active"}
            title={
              lifecycle === "active"
                ? "Register a new version of this file"
                : `This file is ${lifecycle}. Restore it before you add a version.`
            }
            onClick={() => setUploadOpen(true)}
            className={cn(
              "inline-flex items-center gap-[6px] rounded-md border border-border bg-surface-2 px-[11px] py-[5px] text-[0.74rem] font-semibold text-foreground transition-colors",
              "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <Plus className="size-[13px]" strokeWidth={2.4} />
            Add a version
          </button>
        }
      />

      <div className="border-b border-line-2 px-4 py-2 text-[0.74rem] text-ink-3">
        Each version is a whole file: it keeps its own bytes, its own checksum, its own id and its
        own download. A new version never overwrites an earlier one, and the registry deletes no
        earlier version. Copy link gives the permanent address of that one version, and a later
        version never takes it over. The receiver signs in with their own account.
      </div>

      {file.supersedes != null && (
        /* The chain link this very version carries. The rows above are whole
           `FileEntity` documents without the field, so only the open detail
           can state it. */
        <div className="border-b border-line-2 px-4 py-2 text-[0.72rem] text-ink-3">
          This version supersedes{" "}
          <Link
            href={`/files/${encodeURIComponent(file.supersedes)}`}
            className="font-mono text-[0.7rem] text-primary hover:underline"
          >
            {file.supersedes}
          </Link>
          .
        </div>
      )}

      {versionsQuery.isPending && (
        <div className="space-y-2 px-4 py-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {versionsQuery.isError && (
        <ErrorState
          message={`Could not load the version history of ${file.filename}.`}
          onRetry={() => void versionsQuery.refetch()}
        />
      )}

      {!versionsQuery.isPending && !versionsQuery.isError && rows.length === 0 && (
        <EmptyState message="This file has no version row yet." />
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-line-2">
          {rows.map((row) => (
            <li
              key={row.file_id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-[11px]"
            >
              <ToneBadge tone={row.file_id === newestId ? "green" : "neutral"}>
                v{versionOf(row)}
              </ToneBadge>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[0.78rem] font-semibold">{row.filename}</span>
                  {row.file_id === newestId && (
                    <span className="text-[0.7rem] text-ink-3">newest</span>
                  )}
                  <StatusBadge status={row.status} />
                  <LifecycleBadge lifecycle={row.lifecycle ?? "active"} />
                </div>
                <div className="mt-[3px] font-mono text-[0.66rem] break-all text-ink-3">
                  {row.file_id} · sha256:{row.checksum_sha256}
                </div>
                <div className="mt-px text-[0.72rem] text-ink-3">
                  {formatBytes(row.size_bytes)} · registered {formatArrival(row.registered_at)}
                </div>
              </div>
              <CopyLinkButton row={row} />
              <DownloadButton
                fileId={row.file_id}
                filename={row.filename}
                sizeBytes={row.size_bytes}
                quarantined={row.status === "quarantined"}
                variant="row"
              />
            </li>
          ))}
        </ul>
      )}

      <UploadVersionDialog file={file} open={uploadOpen} onOpenChange={setUploadOpen} />
    </Panel>
  );
}
