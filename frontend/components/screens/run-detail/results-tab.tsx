"use client";

import { useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePager } from "@/components/shared/table-pager";
import { formatArrival } from "@/lib/format";
import { useResults, useRunFiles } from "@/lib/hooks";
import type { ProcessedResult } from "@/types";
import {
  ResultDetailDialog,
  ResultDownloadButton,
  ResultEditButton,
  editedFieldLabels,
} from "./result-detail";
import { UploadResultDialog } from "./upload-result-dialog";

const abbreviate = (name: string) => (name.length > 20 ? `${name.slice(0, 8)}…${name.slice(-8)}` : name);

/**
 * The head of a long value, plus an ellipsis.
 *
 * QuixLab publishes a node's whole SQL as the result's `parameters`. One such
 * cell used to widen the table until the page scrolled sideways, so every long
 * cell clamps here. The clamp runs in JavaScript and not in CSS alone, because
 * a CSS clamp keeps the long string in the DOM and a narrow column still has
 * to hold it.
 *
 * The clamp never loses the value: the cell keeps the whole string in its
 * `title`, and the details dialog prints it whole.
 */
export function clamp(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * How many characters each column keeps.
 *
 * Two results of one QuixLab job often share a long SQL prefix, so the
 * parameters keep a long head. A short clamp would print two rows a person
 * cannot tell apart.
 */
const LIMIT = {
  name: 44,
  description: 72,
  tool: 32,
  parameters: 64,
  inputs: 40,
} as const;

const COL_COUNT = 7;

export function ResultsTab({ runId }: { runId: string }) {
  /* A re-run of the same tool mints version 2 of the same result key. Without
     `latest_only` the tab prints both versions as two rows a viewer cannot
     tell apart, so the default view shows the newest version of each key and
     the control below opens the whole chain. */
  const [everyVersion, setEveryVersion] = useState(false);
  /* The list route pages, and the tab used to read `items` alone — a run with
     more results than one page silently lost the rest. Local state, like the
     signals tab: the run screen owns `?tab=` and a second URL writer would
     fight it. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const resultsQuery = useResults({
    run: runId,
    latest_only: !everyVersion,
    page,
    page_size: pageSize,
  });
  const filesQuery = useRunFiles(runId);
  const [uploadOpen, setUploadOpen] = useState(false);
  /* The result a person opened. `GET /results/{id}` reads it back, so the
     dialog shows the stored version and not the cached row. */
  const [openResult, setOpenResult] = useState<ProcessedResult | null>(null);
  /* True when the pencil opened the result, so the dialog shows the edit form
     at once. The row itself always opens the dialog to read. */
  const [openInEdit, setOpenInEdit] = useState(false);

  const filenameById = new Map(
    (filesQuery.data?.items ?? []).map((file) => [file.file_id, file.filename])
  );
  const items = resultsQuery.data?.items ?? [];

  // The highest version the tab holds for each result key. It marks the newest
  // row when every version shows.
  const newestByKey = new Map<string, number>();
  for (const result of items) {
    const seen = newestByKey.get(result.result_key);
    if (seen === undefined || result.version > seen) newestByKey.set(result.result_key, result.version);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-line-2 px-4 py-2 text-[0.74rem] text-ink-3">
        <label className="group/field inline-flex cursor-pointer items-center gap-2 text-ink-2">
          <Checkbox
            checked={everyVersion}
            onCheckedChange={(checked) => {
              setEveryVersion(checked === true);
              // The toggle swaps the row set, so a page into the old set
              // means nothing in the new one.
              setPage(1);
            }}
            aria-label="Show every version"
          />
          <span>Show every version</span>
        </label>
        <span>
          {everyVersion
            ? "Every version of every result, newest version first."
            : "One row per result — the newest version of each. A re-run mints the next version."}
        </span>
      </div>

      <Table aria-label="Processed results of this run">
        <TableHeader>
          <TableRow>
            <TableHead>Result</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Tool</TableHead>
            <TableHead>Inputs</TableHead>
            <TableHead>Produced</TableHead>
            <TableHead>Provenance</TableHead>
            <TableHead className="w-16">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {resultsQuery.isPending && <LoadingRows rows={1} cols={COL_COUNT} />}
          {resultsQuery.isError && (
            <TableRow>
              <TableCell colSpan={COL_COUNT} className="p-0!">
                <ErrorState
                  message="Could not load processed results."
                  onRetry={() => void resultsQuery.refetch()}
                />
              </TableCell>
            </TableRow>
          )}
          {resultsQuery.isSuccess && items.length === 0 && (
            <TableRow>
              <TableCell colSpan={COL_COUNT} className="p-0!">
                <EmptyState
                  title="No processed results"
                  message="Upload one here, or write it back through the registry API."
                />
              </TableCell>
            </TableRow>
          )}
          {items.map((result) => {
            const tool = `${result.provenance.tool} ${result.provenance.tool_version}`;
            const inputs = result.provenance.input_file_ids
              .map((fileId) => abbreviate(filenameById.get(fileId) ?? fileId))
              .join(" · ");
            // The mark comes from `edited` and from nowhere else. An older API
            // build sends no key, so absent reads the same as null.
            const edited = result.edited ?? null;
            return (
            /* The whole row opens the result to read, the way the Files tab
               opens a file. Every control in the row stops the click, so the
               row never steals one. */
            <TableRow
              key={result.result_id}
              className="cursor-pointer"
              onClick={() => {
                setOpenInEdit(false);
                setOpenResult(result);
              }}
            >
              <TableCell className="max-w-[15rem]">
                {/* The name is text and not a control. The row opens the result
                    to read, and the pencil in the action column opens it to
                    edit, so an underline here promised a third way in that the
                    owner did not want. */}
                <div className="max-w-full truncate font-mono text-[0.78rem]" title={result.name}>
                  {clamp(result.name, LIMIT.name)}
                </div>
                {/* The line above is clamped, and a clamped name is what a
                    screen reader would read. The whole name stays for it. */}
                {result.name.length > LIMIT.name && (
                  <span className="sr-only">{result.name}</span>
                )}
                {result.description !== null && (
                  <div
                    className="mt-px truncate text-[0.72rem] text-ink-3"
                    title={result.description}
                  >
                    {clamp(result.description, LIMIT.description)}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <ToneBadge
                  tone={newestByKey.get(result.result_key) === result.version ? "green" : "neutral"}
                >
                  v{result.version}
                </ToneBadge>
                {result.supersedes !== null && (
                  <div className="mt-px font-mono text-[0.66rem] text-ink-3">
                    replaces {abbreviate(result.supersedes)}
                  </div>
                )}
              </TableCell>
              <TableCell className="max-w-[16rem]">
                <div className="truncate font-mono text-[0.78rem]" title={tool}>
                  {clamp(tool, LIMIT.tool)}
                </div>
                {/* QuixLab publishes a whole SQL statement here. The cell keeps
                    the head, and the `title` keeps every character. */}
                <div
                  className="mt-px truncate font-mono text-[0.66rem] text-ink-3"
                  title={result.provenance.parameters}
                >
                  {clamp(result.provenance.parameters, LIMIT.parameters)}
                </div>
              </TableCell>
              <TableCell className="max-w-[12rem]">
                <span className="block truncate font-mono text-[0.72rem]" title={inputs}>
                  {clamp(inputs, LIMIT.inputs)}
                </span>
              </TableCell>
              <TableCell>{formatArrival(result.created_at)}</TableCell>
              <TableCell>
                {result.provenance_status === "verified" ? (
                  <ToneBadge tone="green" dot>
                    Verified
                  </ToneBadge>
                ) : (
                  <ToneBadge tone="red" dot>
                    Flagged
                  </ToneBadge>
                )}
                {/* A person rewrote part of the provenance, so the row says so
                    beside the state. The badge carries words as well as a
                    colour, and the `title` names the fields and the time. */}
                {edited !== null && (
                  <div
                    className="mt-1"
                    title={`${edited.actor} edited ${editedFieldLabels(edited.fields).join(", ")} on ${formatArrival(edited.at)}`}
                  >
                    <ToneBadge tone="amber">Edited by hand</ToneBadge>
                  </div>
                )}
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-0.5">
                  <ResultEditButton
                    name={result.name}
                    onEdit={() => {
                      setOpenInEdit(true);
                      setOpenResult(result);
                    }}
                  />
                  <ResultDownloadButton
                    resultId={result.result_id}
                    name={result.name}
                    storageRef={result.storage_ref}
                    variant="row"
                  />
                </span>
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* The pager reads the response envelope, so it states the run's whole
          result count even when this page holds a slice of it. */}
      {resultsQuery.data !== undefined && (
        <TablePager
          page={resultsQuery.data.page}
          pageSize={resultsQuery.data.page_size}
          total={resultsQuery.data.total}
          totalPages={resultsQuery.data.total_pages}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      )}

      {/* The footer sits beside the table, the way the signals tab carries its
          pager. It therefore shows on an empty tab too, and the upload control
          reaches a run that holds no result yet. */}
      <div className="flex items-center gap-3.5 border-t border-line-2 bg-surface-2 px-4 py-2.5 text-[0.74rem] text-ink-3">
        <span>
          Post-processing runs outside the platform. A result reaches the registry through the
          registry API, or through Upload result here. Both paths demand the tool, the version, the
          parameters and the input lineage.
        </span>
        {/* text-ink, stated: the outline variant has no text color of its
            own, so the label inherits the footer's text-ink-3 — 3.8:1 on the
            dark outline fill (axe color-contrast). */}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto flex-none font-semibold text-ink"
          onClick={() => setUploadOpen(true)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 19V5M6 11l6-6 6 6" />
            <path d="M4 21h16" />
          </svg>
          Upload result
        </Button>
      </div>

      {/* The dialog mounts on demand. It reads the viewer's Portal profile, and
          a tab nobody opened must not ask the Portal who is looking. */}
      {uploadOpen && (
        <UploadResultDialog runId={runId} open={uploadOpen} onOpenChange={setUploadOpen} />
      )}

      {/* The dialog reads the result back through its own id, so it mounts only
          once a person opens a row. */}
      {openResult !== null && (
        <ResultDetailDialog
          resultId={openResult.result_id}
          fallback={openResult}
          startInEdit={openInEdit}
          open={true}
          onOpenChange={(next) => {
            if (!next) setOpenResult(null);
          }}
        />
      )}
    </>
  );
}
