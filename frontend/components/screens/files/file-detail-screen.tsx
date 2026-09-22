"use client";

import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Ellipsis,
  Flag,
  KeyRound,
  Link2,
  Play,
  Trash2,
} from "lucide-react";
import { AddNoteButton, AddNoteDialog } from "@/components/shared/add-note-dialog";
import { Crumb, Crumbs } from "@/components/shared/crumbs";
import { EmptyState } from "@/components/shared/empty-state";
import {
  EntityHistoryPanel,
  type JournalPanelParams,
} from "@/components/shared/entity-history-panel";
import { ErrorState } from "@/components/shared/error-state";
import { FavouriteStar } from "@/components/shared/favourite-star";
import { LoadingRows } from "@/components/shared/loading-rows";
import { MetaCell, MetaGrid } from "@/components/shared/meta-grid";
import { NewTabMark } from "@/components/shared/new-tab-mark";
import { Panel, PanelHead } from "@/components/shared/panel";
import { RequestAccessDialog } from "@/components/shared/request-access-dialog";
import { SourceBadge } from "@/components/shared/source-badge";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { formatArrival, formatBytes } from "@/lib/format";
import { useFile, useFileJournal, usePageTitle, useRun } from "@/lib/hooks";
import { openQuixLab, quixLabConfigured } from "@/lib/quixlab";
import { cn } from "@/lib/utils";
import { sourced } from "@/types";
import type { FileLifecycleAction } from "@/lib/hooks";
import { DownloadButton } from "./download-button";
import { FileInvalidFlagDialog } from "./file-invalid-flag-dialog";
import { FileSignalsTable } from "./file-signals-table";
import { FileVersionsPanel } from "./file-versions-panel";
import { formatClock, formatDay, splitExtension, truncateFilename } from "./format";
import { IngestionTimeline } from "./ingestion-timeline";
import { LifecycleBadge, LIFECYCLE_SENTENCE } from "./lifecycle-badge";
import { LifecycleDialog } from "./lifecycle-dialog";
import { LinkRunDialog } from "./link-run-dialog";
import { StageStatusPanel } from "./stage-status-panel";

/** The quiet secondary button in the detail header. Download alone is filled.
 *
 * The height is stated, not left to the content. Padding alone gives a
 * labelled button its height from the text line-box (~18px) and an icon-only
 * one from the glyph (15px), so the two sat 3px apart in the same row.
 *
 * The size copies the run detail header exactly — `h-7`, `px-2.5`,
 * `text-[0.74rem]` (`run-detail-screen.tsx:474`). A file header and a run
 * header sit one click apart, so a button that changes size between them reads
 * as a different control. Match that recipe, not the `ui/button.tsx` default,
 * which these hand-rolled header buttons do not use. */
const HEADER_BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 text-[0.74rem] font-semibold whitespace-nowrap text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

interface FileDetailScreenProps {
  fileId: string;
}

export function FileDetailScreen({ fileId }: FileDetailScreenProps) {
  // Which lifecycle dialog is open, or null while none is. Each dialog states
  // the real consequence of its route before a person confirms.
  const [lifecycleAction, setLifecycleAction] = useState<FileLifecycleAction | null>(null);
  // The quarantine repair (TR-003): link an orphaned file to a run by hand.
  const [linkOpen, setLinkOpen] = useState(false);
  // Which half of the invalid mark the dialog asks for, or null while it is
  // shut. The mark is reversible, so both directions live behind one dialog.
  const [invalidMode, setInvalidMode] = useState<"raise" | "clear" | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  // UC-003 step 4. The bytes are behind the Download button on this screen,
  // so this is where a person who cannot use the file meets the wall.
  const [accessOpen, setAccessOpen] = useState(false);
  // The history panel drives the kind filter and the pager through these
  // params, and the journal hook re-queries with them (contract §8b).
  const [journalParams, setJournalParams] = useState<JournalPanelParams>({ page_size: 50 });
  const fileQuery = useFile(fileId);
  const journalQuery = useFileJournal(fileId, journalParams);
  /* The window title names the file the moment it loads (FR-DM-091). */
  usePageTitle(fileQuery.data ? `${fileQuery.data.filename} — file` : null);
  const file = fileQuery.data;
  const runQuery = useRun(file?.run_id ?? "");
  const run = runQuery.data;

  if (fileQuery.isPending) {
    return (
      <>
        <Skeleton className="mb-3.5 h-6 w-2/3" />
        <Skeleton className="mb-[18px] h-12 w-full" />
        <Panel>
          <table className="w-full">
            <tbody>
              <LoadingRows rows={6} cols={4} />
            </tbody>
          </table>
        </Panel>
      </>
    );
  }

  if (fileQuery.isError || file === undefined) {
    return (
      <Panel>
        <ErrorState
          message={`Could not load file ${fileId}.`}
          onRetry={() => void fileQuery.refetch()}
        />
      </Panel>
    );
  }

  const lifecycle = file.lifecycle ?? "active";
  /* A file the registry stored before 24 Aug 2026 carries no block at all, so
     an absent block reads as "nobody marked this file". */
  const invalidFlag = file.invalid;
  const checksum = sourced(file, "checksum_sha256");
  const size = sourced(file, "size_bytes");
  const mismatch = file.checksum_state === "mismatch";
  const { stem, extension } = splitExtension(file.filename);

  return (
    <>
      <Crumbs>
        {run?.work_order_id != null ? (
          <Crumb type="WO" href={`/work-orders/${encodeURIComponent(run.work_order_id)}`}>
            {run.work_order_id}
          </Crumb>
        ) : (
          <Crumb type="WO" missing>
            not yet synced
          </Crumb>
        )}
        {run?.definition_id != null ? (
          <Crumb
            type="Def"
            href={`/definitions/${encodeURIComponent(run.definition_id)}`}
          >
            {run.definition_id}
          </Crumb>
        ) : (
          <Crumb type="Def" missing>
            not yet synced
          </Crumb>
        )}
        {file.run_id !== null ? (
          <Crumb type="Run" href={`/runs/${encodeURIComponent(file.run_id)}`}>
            {file.run_id}
          </Crumb>
        ) : (
          <Crumb type="Run" missing>
            unlinked
          </Crumb>
        )}
        <Crumb type="File" current>
          {truncateFilename(file.filename)}
        </Crumb>
      </Crumbs>

      {/* The mark at file level, beside the run's own banner on the run screen.
          It states who judged the file, when and why, and it offers the way
          back — without this control a mark raised in a rehearsal stands for
          ever. The file keeps every byte and it still downloads. */}
      {invalidFlag?.flagged === true && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2.5 rounded-md border border-red-border bg-red-bg px-3.5 py-[11px] text-[0.8rem]"
        >
          <Flag size={16} className="mt-px flex-none text-red" />
          <div>
            <b className="text-red">Flagged invalid</b> by{" "}
            <span className="font-mono text-[0.72rem] text-ink-2">{invalidFlag.actor}</span>
            {invalidFlag.at !== null && <> · {formatArrival(invalidFlag.at)}</>}
            <br />
            <span className="text-[0.78rem]">{invalidFlag.reason}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto flex-none font-semibold"
            onClick={() => setInvalidMode("clear")}
          >
            Clear invalid flag
          </Button>
        </div>
      )}

      {/* One identity, one ladder of actions. The filename owns its whole
          row: the stem truncates, the extension stays, and `title` carries
          the full value. Download is the one filled primary. The rare and
          the destructive actions live behind More actions, so a careless
          click cannot reach Delete or Flag invalid. */}
      <div className="mb-[18px] flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <div className="flex items-center gap-1.5">
            <h1
              className="flex min-w-0 items-baseline font-mono text-[1.1rem] font-semibold tracking-[-0.01em]"
              title={file.filename}
            >
              <span className="truncate">{stem}</span>
              {extension !== "" && <span className="flex-none">{extension}</span>}
            </h1>
            <FavouriteStar
              type="file"
              id={file.file_id}
              label={file.filename}
              className="flex-none"
            />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <StatusBadge status={file.status} />
            {/* The lifecycle is a separate field from the status, so it gets
                its own badge and never replaces the status badge. */}
            <LifecycleBadge lifecycle={lifecycle} />
            <span className="text-[0.8rem] text-ink-3">
              {/* The header never names a transport. The record proves the
                  acquisition system and the arrival time, and nothing more.
                  The ingestion timeline below names the real actor per step. */}
              {file.format} · {file.source_system} acquisition · landed{" "}
              {formatArrival(file.registered_at)}
            </span>
          </div>
          {file.quarantine_reason !== null && (
            <div className="mt-[3px] text-[0.78rem] text-red">{file.quarantine_reason}</div>
          )}
          {lifecycle !== "active" && (
            <div className="mt-1.5 max-w-[62ch] rounded-md border border-line bg-surface-2 px-3 py-2 text-[0.76rem] text-ink-2">
              {LIFECYCLE_SENTENCE[lifecycle]}
            </div>
          )}
        </div>
        {/* min-w-0 lets this row shrink with a narrow screen, so the
            buttons wrap instead of pushing the page wider. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {file.run_id === null && (
            /* The repair for the demo's dead end (TR-003): an orphaned file
               shows the way back into the lineage, right where the missing
               link shows. It stays a visible button because on such a file
               it is the next act. */
            <button
              type="button"
              onClick={() => setLinkOpen(true)}
              title="State the run this file belongs to — a file quarantined for a missing run key leaves quarantine with the link"
              className={HEADER_BUTTON}
            >
              <Link2 className="size-[13px]" strokeWidth={2.2} />
              Link to run
            </button>
          )}
          {quixLabConfigured() && file.run_id !== null && (
            /* QuixLab opens one run, so the control needs this file's run.
               An orphan file has none, so it shows no control — "Link to
               run" above is its next act. */
            <button
              type="button"
              onClick={() => openQuixLab(undefined, file.run_id)}
              className={HEADER_BUTTON}
            >
              <Play className="size-[13px]" strokeWidth={2.2} />
              <span>Open in QuixLab</span>
              <NewTabMark iconClassName="size-3 opacity-80" />
            </button>
          )}
          <DownloadButton
            fileId={file.file_id}
            filename={file.filename}
            sizeBytes={file.size_bytes}
            quarantined={file.status === "quarantined"}
            variant="header"
          />
          <DropdownMenu>
            {/* Icon-only trigger, so the label must live in aria-label. */}
            <DropdownMenuTrigger
              aria-label="More actions"
              className={cn(HEADER_BUTTON, "px-2")}
            >
              <Ellipsis className="size-[15px]" strokeWidth={2.2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              {/* UC-003 step 4. It grants nothing: it records the ask in the
                  journal, and a person acts on it outside this system. */}
              <DropdownMenuItem
                onClick={() => setAccessOpen(true)}
                title="Record a request for access. The Test Manager grants nothing — a person acts on it."
              >
                <KeyRound className="size-[13px]" strokeWidth={2.2} />
                Request access
              </DropdownMenuItem>
              {lifecycle === "active" ? (
                <DropdownMenuItem onClick={() => setLifecycleAction("archive")}>
                  <Archive className="size-[13px]" strokeWidth={2.2} />
                  Archive
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setLifecycleAction("restore")}>
                  <ArchiveRestore className="size-[13px]" strokeWidth={2.2} />
                  Restore
                </DropdownMenuItem>
              )}
              {/* The destructive pair stands apart, below its own line. Each
                  one still opens a dialog that states the consequence, so no
                  single click marks or deletes anything. */}
              {(invalidFlag?.flagged !== true || lifecycle !== "deleted") && (
                <DropdownMenuSeparator />
              )}
              {invalidFlag?.flagged !== true && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setInvalidMode("raise")}
                  title="Mark the data of this file as not usable — the file keeps every byte, it still downloads, and its run is not marked"
                >
                  <Flag className="size-[13px]" strokeWidth={2.2} />
                  Flag invalid
                </DropdownMenuItem>
              )}
              {lifecycle !== "deleted" && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setLifecycleAction("delete")}
                  title="Soft delete — the registry keeps every byte and a restore brings the file back"
                >
                  <Trash2 className="size-[13px]" strokeWidth={2.2} />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Panel className="mb-3">
        <PanelHead
          title="File metadata"
          action={
            <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-3">
              every field carries its source — <SourceBadge source="embedded" />
            </span>
          }
        />
        <MetaGrid>
          <MetaCell label="Size" source={size.source ?? "embedded"}>
            <span className="font-mono text-[0.78rem]">{formatBytes(file.size_bytes)}</span>
          </MetaCell>
          <MetaCell label="Checksum" source={checksum.source ?? "embedded"}>
            <span
              className={cn(
                "font-mono text-[0.68rem] break-all",
                mismatch && "text-red"
              )}
            >
              sha256:{file.checksum_sha256}
              {mismatch && " · mismatch"}
            </span>
          </MetaCell>
          <MetaCell label="Source system" source="embedded">
            <ToneBadge tone="neutral">{file.source_system}</ToneBadge>
          </MetaCell>
          <MetaCell label="Format" source="embedded">
            <span className="font-mono text-[0.78rem]">{file.format}</span>
          </MetaCell>
          <MetaCell label="Signals" source="embedded">
            <span className="font-mono text-[0.78rem]">{file.signal_count}</span>
          </MetaCell>
          <MetaCell label="Time range" source="embedded">
            <span className="font-mono text-[0.74rem]">
              {formatClock(file.time_start)} → {formatClock(file.time_end)}
            </span>
          </MetaCell>
          <MetaCell label="Storage location">
            <span className="font-mono text-[0.68rem] break-all">{file.storage_ref ?? "—"}</span>
            <div className="mt-px text-[0.72rem] font-normal text-ink-3">
              storage abstracted — consumers never see paths
            </div>
          </MetaCell>
          <MetaCell label="Ingestion job">
            <span className="font-mono text-[0.74rem]">{file.ingestion_job_id ?? "—"}</span>
          </MetaCell>
        </MetaGrid>
      </Panel>

      <StageStatusPanel file={file} className="mb-3" />

      <FileVersionsPanel file={file} className="mb-3" />

      <Panel className="mb-3">
        <PanelHead
          title="Ingestion timeline"
          action={
            file.ingestion_timeline.length > 0 ? (
              <span className="font-mono text-[0.68rem] text-ink-3">
                {file.ingestion_timeline.length} events ·{" "}
                {formatDay(file.ingestion_timeline[0].at)}
              </span>
            ) : undefined
          }
        />
        {file.ingestion_timeline.length > 0 ? (
          <IngestionTimeline entries={file.ingestion_timeline} />
        ) : (
          <EmptyState message="No ingestion events recorded for this file." />
        )}
      </Panel>

      <EntityHistoryPanel
        className="mb-3"
        label="file"
        isPending={journalQuery.isPending}
        isError={journalQuery.isError}
        page={journalQuery.data}
        onRetry={() => void journalQuery.refetch()}
        params={journalParams}
        onParamsChange={setJournalParams}
        action={<AddNoteButton onClick={() => setNoteOpen(true)} />}
      />

      <Panel>
        <PanelHead
          title="Signals in this file"
          action={
            <span className="font-mono text-[0.68rem] text-ink-3">
              {file.signal_count} total
            </span>
          }
        />
        <FileSignalsTable
          signals={file.signals}
          signalCount={file.signal_count}
          quarantined={file.status === "quarantined"}
        />
      </Panel>

      {lifecycleAction !== null && (
        <LifecycleDialog
          fileId={file.file_id}
          filename={file.filename}
          action={lifecycleAction}
          open
          onOpenChange={(next) => {
            if (!next) setLifecycleAction(null);
          }}
        />
      )}
      {/* Mounted only while open, so the run picker's list query never runs
          for a closed dialog. */}
      {linkOpen && (
        <LinkRunDialog
          fileId={file.file_id}
          filename={file.filename}
          open
          onOpenChange={(next) => {
            if (!next) setLinkOpen(false);
          }}
        />
      )}
      {invalidMode !== null && (
        <FileInvalidFlagDialog
          fileId={file.file_id}
          filename={file.filename}
          mode={invalidMode}
          open
          onOpenChange={(next) => {
            if (!next) setInvalidMode(null);
          }}
        />
      )}
      {/* Mounted on demand: the dialog reads the viewer's Portal profile, and
          a screen nobody writes on must not ask the Portal who is looking. */}
      {noteOpen && (
        <AddNoteDialog entityType="file" entityId={file.file_id} open onOpenChange={setNoteOpen} />
      )}
      {accessOpen && (
        <RequestAccessDialog
          entityType="file"
          entityId={file.file_id}
          entityLabel={file.filename}
          open
          onOpenChange={setAccessOpen}
        />
      )}
    </>
  );
}
