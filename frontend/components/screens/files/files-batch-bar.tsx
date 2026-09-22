"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Download, Flag, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/client";
import { triggerBrowserDownload } from "@/lib/api/download";
import { filesApi } from "@/lib/api/files";
import { formatInt } from "@/lib/format";
import { keys, useActor, useAnnounce } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import type { FileEntity } from "@/types";
import { truncateFilename } from "./format";

/* This bar repeats the selection shape of `run-detail/signals-tab.tsx` rather
   than sharing a component with it. That tab holds its selection in its PARENT
   (`selected` / `onSelectedChange`), because the QuixLab panel reads the same
   list; this screen owns its selection. The shared part is a dozen lines of Set
   arithmetic, so a shared hook would edit a demo-path screen and its suite for
   no change in behaviour. The BEHAVIOUR is the same on both screens: the header
   box covers this page, and a row box covers its row. */

/** The two batch writes this screen offers. There is no batch delete. */
export type FileBatchAction = "invalid" | "archive";

/**
 * The tone of an action, by what the action does — never by taste.
 *
 * - `red` — destructive. Only a delete takes it. This bar has no batch
 *   delete, so red reaches the confirm button of a danger dialog alone.
 * - `amber` — a judgement a person must stand behind (flag invalid).
 * - `green` — restorative (restore, clear flag). Those actions live on the
 *   file detail screen today, so the tone waits here for them.
 * - `neutral` — routine reads and moves (download, archive, clear).
 *
 * Colour is never the only signal (WCAG 1.4.1): every button keeps its text
 * label and an icon, and the label alone says what the button does.
 */
type ActionTone = "neutral" | "red" | "amber" | "green";

/* Semantic tokens only — each pair flips with the dark theme by itself. The
   `dark:` entries exist to beat the outline variant's own dark classes, not
   to pick new colours. There is no `--green-border` token; the dot token is
   the nearest green line the system has. */
const TONE_CLASS: Record<ActionTone, string> = {
  neutral: "",
  red: "border-red-border bg-red-bg text-red hover:border-red hover:bg-red-bg hover:text-red dark:border-red-border dark:bg-red-bg dark:hover:bg-red-bg",
  amber:
    "border-amber-border bg-amber-bg text-amber hover:border-amber hover:bg-amber-bg hover:text-amber dark:border-amber-border dark:bg-amber-bg dark:hover:bg-amber-bg",
  green:
    "border-green-dot bg-green-bg text-green hover:border-green hover:bg-green-bg hover:text-green dark:border-green-dot dark:bg-green-bg dark:hover:bg-green-bg",
};

/** The rows the bar acts on. The status and the lifecycle let the download
    skip a file the route would refuse, and say so instead of failing it. */
type PickedFile = Pick<FileEntity, "file_id" | "filename" | "status" | "lifecycle">;

interface FilesBatchBarProps {
  /** The picked files, in table order. Only rows on the page reach here. */
  readonly files: readonly PickedFile[];
  /** Clear the selection, or keep the files a call refused. */
  onSelectionChange: (fileIds: readonly string[]) => void;
}

interface Failure {
  readonly fileId: string;
  readonly filename: string;
  readonly message: string;
}

const WORDS: Record<
  FileBatchAction,
  {
    button: string;
    title: (count: number) => string;
    description: string;
    reasonRequired: boolean;
    label: string;
    placeholder: string;
    submit: (count: number) => string;
    done: (count: number) => string;
    tone: ActionTone;
  }
> = {
  invalid: {
    button: "Mark invalid",
    title: (count) => `Mark ${formatInt(count)} ${count === 1 ? "file" : "files"} as invalid`,
    description:
      "Every file stays in the registry, keeps every byte and still downloads. No run is marked. The reason goes into each file journal with your name.",
    reasonRequired: true,
    label: "Reason for flagging these files invalid",
    placeholder: "e.g. Cell 7 thermocouple came loose at 10:12 — the traces are noise",
    submit: (count) => `Flag ${formatInt(count)} invalid`,
    done: (count) => `${formatInt(count)} ${count === 1 ? "file" : "files"} flagged invalid`,
    /* A flag is a judgement, not a delete. Amber says "stop and think",
       and the dialog still demands a reason. */
    tone: "amber",
  },
  archive: {
    button: "Archive",
    title: (count) => `Archive ${formatInt(count)} ${count === 1 ? "file" : "files"}`,
    description:
      "Every file leaves the file table and keeps every byte. It still downloads. An edit and a new version both refuse until a person restores it. The status does not change.",
    reasonRequired: false,
    label: "Note for the journal (optional)",
    placeholder: "e.g. Cycle closed — the raw files move to the archive",
    submit: (count) => `Archive ${formatInt(count)}`,
    done: (count) => `${formatInt(count)} ${count === 1 ? "file" : "files"} archived`,
    tone: "neutral",
  },
};

/** One sentence a person can act on, per refusal the two routes answer. */
const FAILURES: Record<string, string> = {
  already_flagged: "It already carries the invalid mark.",
  file_deleted: "It is deleted. Restore it first.",
  file_not_found: "The registry holds no file under this id any more.",
  reason_required: "A reason is required.",
  validation_error: "The registry refused the reason.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused it: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The call never reached the registry.";
}

/* ---- Batch download ------------------------------------------------------ */

/* The download route refuses these files by rule, not by fault. The bar
   knows both facts from the row, so it skips the call and says why. The
   same rule is caught again below, in case the row is stale. */
const SKIP_QUARANTINED = "It is quarantined. The registry refuses its download.";
const SKIP_DELETED = "It is deleted. Restore it first.";

/** True when the route refused by rule — the file is a skip, not a failure. */
function isDownloadRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "not_allowed" || error.code === "file_deleted");
}

function downloadMessageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "not_allowed") return SKIP_QUARANTINED;
    if (error.code === "file_deleted") return SKIP_DELETED;
    if (error.status === 503) {
      return "Storage unreachable — download is available in the deployed environment.";
    }
    return `The registry refused it: ${error.detail}`;
  }
  return "The call never reached the registry.";
}

/**
 * The honest end-state of one download batch. `picked` is the count the
 * batch started with, so the report cannot shrink when a person unticks a
 * row while the batch runs.
 */
interface DownloadReport {
  readonly picked: number;
  readonly downloaded: number;
  readonly skipped: readonly Failure[];
  readonly failed: readonly Failure[];
  /** Files never attempted, because the person cancelled the batch. */
  readonly notStarted: number;
}

function downloadSummary(report: DownloadReport): string {
  const parts = [
    `Downloaded ${formatInt(report.downloaded)} of ${formatInt(report.picked)} picked files.`,
  ];
  if (report.skipped.length > 0) parts.push(`${formatInt(report.skipped.length)} skipped.`);
  if (report.failed.length > 0) parts.push(`${formatInt(report.failed.length)} failed.`);
  if (report.notStarted > 0) parts.push(`${formatInt(report.notStarted)} never started.`);
  return parts.join(" ");
}

export function FilesBatchBar({ files, onSelectionChange }: FilesBatchBarProps) {
  const [action, setAction] = useState<FileBatchAction | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<{ ok: number; failures: readonly Failure[] } | null>(null);

  /* Download state. `progress` renders "Downloading X of Y" in the bar;
     `stopping` renders the cancel as taken; `report` is the end-state box. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [report, setReport] = useState<DownloadReport | null>(null);
  const cancelAsked = useRef(false);

  const actor = useActor();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const count = files.length;

  // A person who ticks nothing sees the screen exactly as it was.
  if (count === 0) return null;

  const words = action === null ? null : WORDS[action];
  const running = sent !== null;
  const downloading = progress !== null;
  /* Once a batch ends the refused files alone stay picked, so `count` shrinks.
     The dialog must keep stating the number the batch really touched. */
  const dialogCount = outcome === null ? count : outcome.ok + outcome.failures.length;

  const close = (open: boolean) => {
    if (running) return;
    if (!open) {
      setAction(null);
      setReason("");
      setFailure(null);
      setOutcome(null);
    }
  };

  const openDialog = (next: FileBatchAction) => {
    setAction(next);
    setReason("");
    setFailure(null);
    setOutcome(null);
  };

  /* One file at a time, and a refusal never stops the rest. The registry takes
     one file per call, so a batch is a loop over the single-file routes. */
  const run = async () => {
    if (action === null || actor === null) return;
    const trimmed = reason.trim();
    if (WORDS[action].reasonRequired && trimmed.length === 0) {
      setFailure("A reason is required.");
      return;
    }
    setFailure(null);
    setOutcome(null);
    setSent(0);

    const failures: Failure[] = [];
    for (const file of files) {
      try {
        if (action === "invalid") {
          await filesApi.flagInvalid(file.file_id, { reason: trimmed, actor });
        } else {
          await filesApi.archive(file.file_id, {
            actor,
            ...(trimmed.length > 0 ? { note: trimmed } : {}),
          });
        }
      } catch (error) {
        failures.push({
          fileId: file.file_id,
          filename: file.filename,
          message: messageFor(error),
        });
      }
      setSent((done) => (done ?? 0) + 1);
    }

    setSent(null);
    // The rows moved, so the table, the run views and the home rollups are stale.
    void queryClient.invalidateQueries({ queryKey: keys.files.all });
    void queryClient.invalidateQueries({ queryKey: keys.runs.all });
    void queryClient.invalidateQueries({ queryKey: keys.home });
    // Keep the refused files picked, so a retry is one click. Nothing else stays.
    onSelectionChange(failures.map((entry) => entry.fileId));

    const ok = count - failures.length;
    if (failures.length === 0) {
      toast(WORDS[action].done(ok));
      setAction(null);
      setReason("");
      return;
    }
    /* A partial failure never closes and never toasts a success. It states both
       counts and names every file the registry refused. */
    setOutcome({ ok, failures });
  };

  /**
   * Download every picked file through the audited single-file route,
   * one call at a time. The route writes its `file.downloaded` journal
   * entry before the first byte, so this loop keeps the audit trail
   * exactly — one row per file a person really received. Sequential on
   * purpose: a burst of N calls would hammer the store, and a cancel
   * could not land between files.
   */
  const runDownloads = async () => {
    if (downloading) return;
    cancelAsked.current = false;
    setStopping(false);
    setReport(null);

    // Skip, never silently drop: a file the route refuses by rule goes
    // into the report with the rule spelled out, and takes no call.
    const skipped: Failure[] = [];
    const targets: PickedFile[] = [];
    for (const file of files) {
      if (file.status === "quarantined") {
        skipped.push({ fileId: file.file_id, filename: file.filename, message: SKIP_QUARANTINED });
      } else if (file.lifecycle === "deleted") {
        skipped.push({ fileId: file.file_id, filename: file.filename, message: SKIP_DELETED });
      } else {
        targets.push(file);
      }
    }

    const picked = skipped.length + targets.length;
    const failed: Failure[] = [];
    let downloaded = 0;
    let started = 0;
    setProgress({ done: 0, total: targets.length });

    for (const file of targets) {
      // A cancel lands here, between files. The file already in flight
      // finishes — its journal row is written, so its bytes must arrive.
      if (cancelAsked.current) break;
      started += 1;
      setProgress({ done: started, total: targets.length });
      announce(`Downloading ${formatInt(started)} of ${formatInt(targets.length)}: ${file.filename}`);
      try {
        const result = await filesApi.download(file.file_id, file.filename);
        triggerBrowserDownload(result.blob, result.filename);
        downloaded += 1;
      } catch (error) {
        const entry = {
          fileId: file.file_id,
          filename: file.filename,
          message: downloadMessageFor(error),
        };
        // The row was stale and the route refused by rule — a skip, not a fault.
        if (isDownloadRefusal(error)) skipped.push(entry);
        else failed.push(entry);
      }
    }

    const result: DownloadReport = {
      picked,
      downloaded,
      skipped,
      failed,
      notStarted: targets.length - started,
    };
    setProgress(null);
    setStopping(false);
    announce(downloadSummary(result));

    // A clean sweep gets a toast and nothing else. Anything less than a
    // clean sweep gets the full report — never a success it did not earn.
    if (result.downloaded === result.picked) {
      toast(`${formatInt(downloaded)} ${downloaded === 1 ? "file" : "files"} downloaded`);
      return;
    }
    setReport(result);
  };

  const cancelDownloads = () => {
    cancelAsked.current = true;
    setStopping(true);
    announce("Stopping after the current file.");
  };

  return (
    <>
      <div
        role="region"
        aria-label="Batch actions for the picked files"
        className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[0.76rem] text-ink-3"
      >
        <span className="font-semibold text-ink-2">
          {formatInt(count)} {count === 1 ? "file" : "files"} picked.
        </span>
        {progress === null ? (
          <Button variant="outline" size="sm" onClick={() => void runDownloads()}>
            <Download className="size-[13px]" strokeWidth={2.2} />
            Download
          </Button>
        ) : (
          <>
            {/* Visible progress only — `announce` speaks it through the one
                app live region, so no second live region doubles it. */}
            <span className="font-medium text-ink-2">
              Downloading {formatInt(progress.done)} of {formatInt(progress.total)}…
            </span>
            <Button variant="outline" size="sm" disabled={stopping} onClick={cancelDownloads}>
              <X className="size-[13px]" strokeWidth={2.2} />
              {stopping ? "Stopping…" : "Cancel download"}
            </Button>
          </>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={downloading}
          onClick={() => openDialog("archive")}
        >
          <Archive className="size-[13px]" strokeWidth={2.2} />
          {WORDS.archive.button}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={downloading}
          className={TONE_CLASS[WORDS.invalid.tone]}
          onClick={() => openDialog("invalid")}
        >
          <Flag className="size-[13px]" strokeWidth={2.2} />
          {WORDS.invalid.button}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={downloading}
          onClick={() => onSelectionChange([])}
        >
          Clear
        </Button>

        {report !== null && (
          <div
            role="alert"
            className={`w-full rounded-md border px-3 py-2 text-[0.76rem] text-ink-2 ${
              report.failed.length > 0
                ? "border-red-border bg-red-bg"
                : "border-amber-border bg-amber-bg"
            }`}
          >
            <p className="font-semibold">{downloadSummary(report)}</p>
            {report.skipped.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {report.skipped.map((entry) => (
                  <li key={entry.fileId}>
                    <span className="font-mono text-[0.74rem]">
                      {truncateFilename(entry.filename)}
                    </span>{" "}
                    — skipped. {entry.message}
                  </li>
                ))}
              </ul>
            )}
            {report.failed.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {report.failed.map((entry) => (
                  <li key={entry.fileId}>
                    <span className="font-mono text-[0.74rem]">
                      {truncateFilename(entry.filename)}
                    </span>{" "}
                    — failed. {entry.message}
                  </li>
                ))}
              </ul>
            )}
            {report.notStarted > 0 && (
              <p className="mt-1.5">
                {formatInt(report.notStarted)}{" "}
                {report.notStarted === 1 ? "file" : "files"} never started — you cancelled the
                batch.
              </p>
            )}
            <div className="mt-1.5">
              <Button variant="ghost" size="sm" onClick={() => setReport(null)}>
                Dismiss report
              </Button>
            </div>
          </div>
        )}
      </div>

      <Dialog open={action !== null} onOpenChange={close}>
        <DialogContent className="rounded-[10px] p-5 sm:max-w-[460px]">
          {words !== null && (
            <>
              <DialogHeader>
                <DialogTitle className="text-base font-bold tracking-[-0.01em]">
                  {words.title(dialogCount)}
                </DialogTitle>
                <DialogDescription className="text-[0.8rem] text-ink-2">
                  {words.description}
                </DialogDescription>
              </DialogHeader>

              {actor === null && (
                <div
                  role="alert"
                  className="rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2"
                >
                  {NO_ACTOR_MESSAGE}
                </div>
              )}

              {outcome === null && (
                <div>
                  <Textarea
                    autoFocus
                    value={reason}
                    aria-invalid={failure !== null || undefined}
                    aria-label={words.label}
                    placeholder={words.placeholder}
                    className="min-h-[84px] bg-surface-2 text-[0.82rem] focus-visible:bg-surface"
                    onChange={(event) => {
                      setReason(event.target.value);
                      if (event.target.value.trim().length > 0) setFailure(null);
                    }}
                  />
                  {failure !== null && (
                    <div role="alert" className="mt-1 text-[0.68rem] text-red">
                      {failure}
                    </div>
                  )}
                </div>
              )}

              {/* The live region stands before the batch starts, so a screen
                  reader announces each step it reports. */}
              {outcome === null && (
                <div role="status" className="text-[0.76rem] text-ink-2">
                  {running ? `Working — ${formatInt(sent ?? 0)} of ${formatInt(count)} sent.` : ""}
                </div>
              )}

              {outcome !== null && (
                <div
                  role="alert"
                  className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-ink-2"
                >
                  <p className="font-semibold">
                    {formatInt(outcome.ok)} of {formatInt(outcome.ok + outcome.failures.length)}{" "}
                    succeeded. {formatInt(outcome.failures.length)} failed.
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {outcome.failures.map((entry) => (
                      <li key={entry.fileId}>
                        <span className="font-mono text-[0.74rem]">
                          {truncateFilename(entry.filename)}
                        </span>{" "}
                        — {entry.message}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5">The failed files stay picked, so you can try again.</p>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={running} onClick={() => close(false)}>
                  {outcome === null ? "Cancel" : "Done"}
                </Button>
                {outcome === null && (
                  <Button
                    size="sm"
                    disabled={actor === null || running}
                    className={
                      words.tone === "neutral" ? undefined : TONE_CLASS[words.tone]
                    }
                    onClick={() => void run()}
                  >
                    {running ? "Working…" : words.submit(count)}
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
