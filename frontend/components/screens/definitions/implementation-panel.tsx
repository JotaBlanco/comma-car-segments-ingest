"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { MetaCell, MetaGrid } from "@/components/shared/meta-grid";
import { Panel, PanelHead } from "@/components/shared/panel";
import { ApiError } from "@/lib/api/client";
import { triggerBrowserDownload } from "@/lib/api/download";
import { testDefinitionsApi } from "@/lib/api/testDefinitions";
import { formatArrival, formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DefinitionImplementation } from "@/types";

/**
 * The Implementation panel of the definition detail screen.
 *
 * The third artefact of the chain: requirement -> test case -> the `.py` that
 * decides the verdict. The panel names the bytes by their sha256, because that
 * digest is what a verdict cites as `tool_version`, and it serves them through
 * the download proxy so the reader can open the module they are looking at.
 */
interface ImplementationPanelProps {
  tdId: string;
  implementation: DefinitionImplementation | null | undefined;
  className?: string;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.detail;
  return "The registry never answered. Check the connection and try again.";
}

export function ImplementationPanel({
  tdId,
  implementation,
  className,
}: ImplementationPanelProps) {
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (implementation === null || implementation === undefined) {
    return (
      <Panel className={className}>
        <PanelHead title="Implementation" />
        <EmptyState message="No test implementation is stored for this definition yet." />
      </Panel>
    );
  }

  const save = () => {
    setFailure(null);
    setSaving(true);
    testDefinitionsApi
      .downloadImplementation(tdId, implementation.filename)
      .then((outcome) => triggerBrowserDownload(outcome.blob, outcome.filename))
      .catch((error: unknown) => setFailure(messageFor(error)))
      .finally(() => setSaving(false));
  };

  return (
    <Panel className={className}>
      <PanelHead
        title="Implementation"
        action={
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className={cn(
              "inline-flex items-center gap-[6px] rounded-md border border-border bg-surface-2 px-[11px] py-[5px] text-[0.74rem] font-semibold text-foreground transition-colors",
              "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <Download className="size-[13px]" strokeWidth={2.2} />
            {saving ? "Fetching…" : "Download"}
          </button>
        }
      />
      {failure !== null && (
        <div role="alert" className="border-b border-line-2 px-4 py-2 text-[0.72rem] text-red">
          {failure}
        </div>
      )}
      <MetaGrid>
        <MetaCell label="File">
          <span className="font-mono text-[0.78rem]">{implementation.filename}</span>
        </MetaCell>
        <MetaCell label="Entry point">
          <span className="font-mono text-[0.78rem]">{implementation.entrypoint}</span>
        </MetaCell>
        <MetaCell label="Language">
          <span className="font-mono text-[0.78rem]">{implementation.language}</span>
        </MetaCell>
        <MetaCell label="Size">
          <span className="font-mono text-[0.78rem]">
            {formatBytes(implementation.size_bytes)}
          </span>
        </MetaCell>
        <MetaCell label="sha256">
          <span className="font-mono text-[0.72rem] break-all">{implementation.sha256}</span>
        </MetaCell>
        <MetaCell label="Blob path">
          <span className="font-mono text-[0.72rem] break-all">
            {implementation.blob_path}
          </span>
        </MetaCell>
        <MetaCell label="Uploaded">{formatArrival(implementation.uploaded_at)}</MetaCell>
        <MetaCell label="Uploaded by">
          <span className="font-mono text-[0.78rem]">
            {implementation.uploaded_by ?? "—"}
          </span>
        </MetaCell>
      </MetaGrid>
    </Panel>
  );
}
