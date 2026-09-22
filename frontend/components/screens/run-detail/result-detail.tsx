"use client";

/**
 * The screen half of TR-006 — a result version you can open and download.
 *
 * `c80b2b7` gave the Results tab a Version column, so two versions of one
 * result stopped reading as two identical rows. The row's own clause stayed
 * open: a version had no address of its own. `GET /results/{result_id}` and
 * `GET /results/{result_id}/download` close it (contract §B #18b and #18c),
 * and this file is the screen that reaches them. A route with no screen leaves
 * the row half closed.
 *
 * Three exports:
 *
 * * `ResultDownloadButton` — the icon action on a table row.
 * * `ResultEditButton` — the pencil action on a table row. It opens the dialog
 *   below with the edit form already up.
 * * `ResultDetailDialog` — the dialog a person opens from a row. It calls
 *   `GET /results/{result_id}`, so the dialog reads the stored version and
 *   never the row the list happened to cache.
 *
 * A result that names no `storage_ref` holds no bytes here. The button says so
 * and never fires, and the API says the same with 409 `result_has_no_bytes`.
 * This is courtesy, not the enforcement point.
 */

import { Check, Download, Loader2, Pencil } from "lucide-react";
import { useCallback, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import {
  EntityHistoryPanel,
  type JournalPanelParams,
} from "@/components/shared/entity-history-panel";
import { ErrorState } from "@/components/shared/error-state";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api/client";
import { triggerBrowserDownload } from "@/lib/api/download";
import { resultsApi } from "@/lib/api/results";
import { formatArrival } from "@/lib/format";
import { useResult, useResultJournal } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { ProcessedResult } from "@/types";
import { EditResultDialog } from "./edit-result-dialog";

/**
 * One sentence a person can act on, per error the download route answers.
 * See §B #18c in `plans/API-CONTRACT.md`.
 */
const DOWNLOAD_ERRORS: Record<string, string> = {
  result_has_no_bytes:
    "This result names no stored file, so the registry holds no bytes for it. The result record itself is complete.",
  storage_unreachable:
    "Storage unreachable — the result bytes are available in the deployed environment.",
  not_ready: "The audit journal refused the entry, so no bytes were served. Try again in a moment.",
  result_not_found: "This result is no longer in the registry.",
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return DOWNLOAD_ERRORS[error.code] ?? error.detail;
  }
  if (error instanceof Error) return error.message;
  return "The download failed.";
}

type DownloadState = "idle" | "fetching" | "done";

interface ResultDownloadButtonProps {
  resultId: string;
  name: string;
  /** Null when the result names no stored file. The button then never fires. */
  storageRef: string | null;
  /** "row" renders the icon-only action; "dialog" renders the labelled button. */
  variant: "row" | "dialog";
}

export function ResultDownloadButton({
  resultId,
  name,
  storageRef,
  variant,
}: ResultDownloadButtonProps): React.ReactElement {
  const [state, setState] = useState<DownloadState>("idle");
  const hasBytes = storageRef !== null && storageRef.trim() !== "";

  const runDownload = useCallback(async () => {
    if (state !== "idle" || !hasBytes) return;
    setState("fetching");
    try {
      const outcome = await resultsApi.download(resultId, name);
      triggerBrowserDownload(outcome.blob, outcome.filename);
      setState("done");
      // No "checksum verified" wording here. No check ever runs on a result's
      // bytes, so the download carries no `X-Checksum-State` and no screen may
      // claim one.
      toast.success("Downloaded", { description: outcome.filename });
      window.setTimeout(() => setState("idle"), 1400);
    } catch (error) {
      setState("idle");
      toast.error("Download failed", { description: errorMessage(error) });
    }
  }, [hasBytes, name, resultId, state]);

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // The row variant sits inside a table row that may carry its own handler.
    event.stopPropagation();
    void runDownload();
  };

  const busy = state === "fetching";
  const done = state === "done";
  const disabled = !hasBytes || busy;
  const title = hasBytes
    ? `Download ${name}`
    : `${name} names no stored file, so there is nothing to download`;

  const icon = busy ? (
    <Loader2 className="size-[13px] animate-spin" strokeWidth={2.2} />
  ) : done ? (
    <Check className="size-[13px] text-green" strokeWidth={2.4} />
  ) : (
    <Download className="size-[13px]" strokeWidth={2.2} />
  );

  if (variant === "row") {
    return (
      <button
        type="button"
        aria-label={hasBytes ? `Download ${name}` : `Download disabled: ${title}`}
        aria-busy={busy}
        disabled={disabled}
        title={title}
        onClick={onClick}
        data-download-state={state}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md border border-transparent text-ink-2 outline-none transition-colors",
          "hover:border-border hover:bg-surface-2 hover:text-foreground",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
          "disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        {icon}
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-busy={busy}
      disabled={disabled}
      title={title}
      onClick={onClick}
      data-download-state={state}
      className={cn(
        "inline-flex items-center gap-[7px] rounded-md border border-border bg-surface-2 px-[13px] py-[7px] text-[0.78rem] font-semibold text-foreground transition-colors",
        "hover:bg-muted",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:pointer-events-none disabled:opacity-60",
      )}
    >
      {icon}
      {done ? "Downloaded" : busy ? "Downloading…" : hasBytes ? "Download" : "No stored file"}
    </button>
  );
}

/**
 * The row action that opens a result for editing.
 *
 * The row itself opens the result to read, so a second "open details" control
 * beside it repeated the row. The pencil says what the row cannot: it opens the
 * same dialog with the edit form already up.
 */
export function ResultEditButton({
  name,
  onEdit,
}: {
  name: string;
  onEdit: () => void;
}): React.ReactElement {
  const label = `Edit ${name}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // The row carries its own handler, so the click must stop here or the
      // row opens the dialog to read at the same time.
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onEdit();
      }}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md border border-transparent text-ink-2 outline-none transition-colors",
        "hover:border-border hover:bg-surface-2 hover:text-foreground",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    >
      <Pencil className="size-[13px]" strokeWidth={2.2} />
    </button>
  );
}

interface ResultDetailDialogProps {
  resultId: string;
  /** The row the list already holds. It fills the dialog while the read runs. */
  fallback: ProcessedResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True when the pencil opened the dialog, so the edit form shows at once. */
  startInEdit?: boolean;
}

/** One label-and-value line of the dialog. `wide` takes the whole grid row. */
function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <div className="mb-[3px] text-[0.63rem] font-semibold tracking-[0.08em] text-ink-3 uppercase">
        {label}
      </div>
      <div className="text-[0.8rem] break-words">{children}</div>
    </div>
  );
}

/**
 * The display names of the fields one edit changed.
 *
 * The journal writes a full path, for example `result.provenance.parameters`.
 * The screens drop the `result.` head, because every field on this screen
 * belongs to the result and the head says nothing.
 */
export function editedFieldLabels(fields: string[]): string[] {
  return fields.map((field) => (field.startsWith("result.") ? field.slice("result.".length) : field));
}

export function ResultDetailDialog({
  resultId,
  fallback,
  open,
  onOpenChange,
  startInEdit = false,
}: ResultDetailDialogProps): React.ReactElement {
  const query = useResult(open ? resultId : null);
  /* The result's own history (TR-012) — the same panel, filter and pager the
     other entity screens mount. The `open` guard keeps the read off the wire
     until a person opens the dialog, like the detail read above. */
  const [journalParams, setJournalParams] = useState<JournalPanelParams>({ page_size: 50 });
  const journalQuery = useResultJournal(open ? resultId : null, journalParams);
  // The read is the truth. The row fills the dialog until it lands, so the
  // dialog never opens empty.
  const result = query.data ?? fallback;
  const [editOpen, setEditOpen] = useState(startInEdit);
  // The mark comes from `edited` and from nowhere else. An older API build
  // sends no key, so absent reads the same as null.
  const edited = result.edited ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-[0.9rem] break-all">{result.name}</DialogTitle>
          <DialogDescription>
            Version {result.version} of {result.result_key} · run {result.run_id}
          </DialogDescription>
        </DialogHeader>

        {query.isError ? (
          <ErrorState
            message="Could not read this result."
            onRetry={() => void query.refetch()}
          />
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
            {/* A person edited part of this result, so the dialog names the
                fields, the time and the person. It reads `edited` and it holds
                no store of its own. */}
            {edited !== null && (
              <div
                className="col-span-2 rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2"
                title={`${edited.actor} edited ${editedFieldLabels(edited.fields).join(", ")} on ${formatArrival(edited.at)}`}
              >
                <ToneBadge tone="amber">Edited by hand</ToneBadge>{" "}
                <span>
                  {edited.actor} changed{" "}
                  <span className="font-mono text-[0.72rem]">
                    {editedFieldLabels(edited.fields).join(", ")}
                  </span>{" "}
                  on {formatArrival(edited.at)}. The provenance below states what somebody says the
                  tool did.
                </span>
              </div>
            )}
            <Field label="Name">
              <span className="font-mono text-[0.75rem] break-all">{result.name}</span>
            </Field>
            <Field label="Result id">
              <span className="font-mono text-[0.72rem]">{result.result_id}</span>
            </Field>
            <Field label="Result key">
              <span className="font-mono text-[0.72rem] break-all">{result.result_key}</span>
            </Field>
            <Field label="Version">v{result.version}</Field>
            <Field label="Replaces">
              {result.supersedes === null ? (
                <span className="text-ink-3">Nothing — this is the first version</span>
              ) : (
                <span className="font-mono text-[0.72rem]">{result.supersedes}</span>
              )}
            </Field>
            <Field label="Description">
              {result.description ?? <span className="text-ink-3">None</span>}
            </Field>
            <Field label="Tool">
              <span className="font-mono text-[0.75rem]">{result.provenance.tool}</span>
            </Field>
            <Field label="Tool version">
              <span className="font-mono text-[0.75rem]">{result.provenance.tool_version}</span>
            </Field>
            {/* Two different facts, so two labelled lines. `produced_at` is
                when the tool ran. `created_at` is when the registry took the
                row. A screen that prints one under the other's name lies. */}
            <Field label="Produced at (the tool ran)">
              {formatArrival(result.provenance.produced_at)}
            </Field>
            <Field label="Created (the registry took it)">{formatArrival(result.created_at)}</Field>
            <Field label="Produced by">{result.provenance.produced_by}</Field>
            <Field label="Provenance">
              {result.provenance_status === "verified" ? (
                <ToneBadge tone="green" dot>
                  Verified
                </ToneBadge>
              ) : (
                <ToneBadge tone="red" dot>
                  Flagged
                </ToneBadge>
              )}
            </Field>
            {/* The parameters are often SQL or a command line, so the block
                keeps the whitespace and wraps. It is never clamped here: the
                table clamps, and this is where the whole value lives. */}
            <Field label="Parameters" wide>
              <pre className="max-h-64 overflow-y-auto rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-[0.72rem] whitespace-pre-wrap break-words">
                {result.provenance.parameters}
              </pre>
            </Field>
            <Field label="Input files" wide>
              {result.provenance.input_file_ids.length === 0 ? (
                <span className="text-ink-3">None — the result claims no lineage</span>
              ) : (
                <span className="font-mono text-[0.72rem] break-all">
                  {result.provenance.input_file_ids.join(" · ")}
                </span>
              )}
            </Field>
            <Field label="Stored file" wide>
              {result.storage_ref === null ? (
                <span className="text-ink-3">
                  None — the bytes live outside this registry
                </span>
              ) : (
                <span className="font-mono text-[0.72rem] break-all">{result.storage_ref}</span>
              )}
            </Field>
          </div>
        )}

        <EntityHistoryPanel
          label="result"
          isPending={journalQuery.isPending}
          isError={journalQuery.isError}
          page={journalQuery.data}
          onRetry={() => void journalQuery.refetch()}
          params={journalParams}
          onParamsChange={setJournalParams}
        />

        <div className="flex items-center gap-3.5 border-t border-line-2 pt-3.5 text-[0.72rem] text-ink-3">
          <span>
            A download writes an audit entry that names you, and it lands before the first byte.
          </span>
          <span className="ml-auto flex flex-none items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <ResultDownloadButton
              resultId={result.result_id}
              name={result.name}
              storageRef={result.storage_ref}
              variant="dialog"
            />
          </span>
        </div>

        {/* The edit dialog mounts on demand. It reads the viewer's Portal
            profile, and a dialog nobody opened must not ask who is looking. */}
        {editOpen && (
          <EditResultDialog result={result} open={editOpen} onOpenChange={setEditOpen} />
        )}
      </DialogContent>
    </Dialog>
  );
}
