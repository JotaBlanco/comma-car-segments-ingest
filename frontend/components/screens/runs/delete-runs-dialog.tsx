"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/client";
import { runsApi } from "@/lib/api/runs";
import { formatInt } from "@/lib/format";
import { keys, useActor, useAnnounce } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import type { RunDeletionReport } from "@/types";

/**
 * The one way a run is deleted — from the runs table's batch bar and from the
 * run detail screen alike. There is no second confirmation anywhere, so there
 * is no second set of words describing what a delete takes.
 *
 * The delete is HARD: the run, every file it registered and the bytes behind
 * them, every signal row those files declared, every processed result, and the
 * samples QuixLake holds under the run's partition folder. The journal is the
 * exception — it keeps every entry and gains a `run.deleted` one
 * (`api/api/services/run_deletion.py` owns that rule and says why).
 */

/** The word a person types to arm the delete. Nothing else arms it. */
export const CONFIRM_WORD = "delete";

/* Semantic tokens only; the pair flips with the dark theme by itself. The
   `dark:` entries beat the outline variant's own dark classes. */
export const DESTRUCTIVE_CLASS =
  "border-red-border bg-red-bg text-red hover:border-red hover:bg-red-bg hover:text-red dark:border-red-border dark:bg-red-bg dark:hover:bg-red-bg";

interface Failure {
  readonly runId: string;
  readonly message: string;
}

/** One sentence a person can act on, per refusal the route answers. */
const FAILURES: Record<string, string> = {
  run_not_found: "The registry holds no run under this id any more.",
  lake_unavailable:
    "QuixLake did not answer, so nothing was removed. Try again once the lakehouse is back.",
  lake_partitions_unaddressable:
    "QuixLake could not name this run's partitions, so nothing was removed. An operator has to look at the table.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused it: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The call never reached the registry.";
}

/** The end-state of one delete batch, in the numbers the API reported. */
export interface DeleteReport {
  readonly deleted: number;
  readonly files: number;
  readonly results: number;
  readonly partitions: number;
  /** Objects storage refused to delete. Their registry rows went anyway. */
  readonly blobsFailed: number;
  /** Runs whose samples nobody deleted, because no lakehouse is configured. */
  readonly lakeSkipped: number;
  readonly failures: readonly Failure[];
}

/** True when the batch took everything it set out to take. */
export function isCleanSweep(report: DeleteReport): boolean {
  return report.failures.length === 0 && report.blobsFailed === 0 && report.lakeSkipped === 0;
}

function summary(report: DeleteReport): string {
  return (
    `${formatInt(report.deleted)} ${report.deleted === 1 ? "run" : "runs"} deleted, ` +
    `${formatInt(report.files)} ${report.files === 1 ? "file" : "files"}, ` +
    `${formatInt(report.partitions)} lakehouse ` +
    `${report.partitions === 1 ? "partition" : "partitions"}.`
  );
}

interface DeleteRunsDialogProps {
  readonly open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The runs to delete, in the order a person sees them. */
  readonly runIds: readonly string[];
  /** Called once the batch ends, whatever it did. */
  onDone?: (report: DeleteReport) => void;
}

export function DeleteRunsDialog({
  open,
  onOpenChange,
  runIds,
  onDone,
}: DeleteRunsDialogProps) {
  const [typed, setTyped] = useState("");
  const [sent, setSent] = useState<number | null>(null);
  const [report, setReport] = useState<DeleteReport | null>(null);

  const actor = useActor();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const count = runIds.length;

  const running = sent !== null;
  const armed = typed.trim().toLowerCase() === CONFIRM_WORD;

  const close = (next: boolean) => {
    // A batch in flight is deleting rows. Closing the dialog would hide the
    // one place that says what it did.
    if (running) return;
    if (!next) {
      setTyped("");
      setReport(null);
    }
    onOpenChange(next);
  };

  /* One run at a time, and a refusal never stops the rest. A delete takes a
     lakehouse partition delete with it, so a burst of N calls would set N
     folder removals going at once — and a failure in the middle would then be
     impossible to place. Sequential keeps the report honest. */
  const run = async () => {
    if (!armed || actor === null || count === 0) return;
    setSent(0);
    setReport(null);

    const failures: Failure[] = [];
    let deleted = 0;
    let files = 0;
    let results = 0;
    let partitions = 0;
    let blobsFailed = 0;
    let lakeSkipped = 0;

    for (const runId of runIds) {
      announce(
        `Deleting ${formatInt(deleted + failures.length + 1)} of ${formatInt(count)}: ${runId}`,
      );
      try {
        const answer: RunDeletionReport = await runsApi.remove(runId, { actor });
        deleted += 1;
        files += answer.files;
        results += answer.results;
        partitions += answer.lake.partitions_deleted;
        blobsFailed += answer.blobs_failed;
        if (answer.lake.status === "skipped") lakeSkipped += 1;
      } catch (error) {
        failures.push({ runId, message: messageFor(error) });
      }
      setSent((done) => (done ?? 0) + 1);
    }

    setSent(null);
    /* The runs are gone, and so are their files, signal rows and results. Every
       list that counts any of them is stale — including Home's rollups. */
    void queryClient.invalidateQueries({ queryKey: keys.runs.all });
    void queryClient.invalidateQueries({ queryKey: keys.files.all });
    void queryClient.invalidateQueries({ queryKey: keys.signals.all });
    void queryClient.invalidateQueries({ queryKey: keys.results.all });
    void queryClient.invalidateQueries({ queryKey: keys.journal.all });
    void queryClient.invalidateQueries({ queryKey: keys.home });

    const result: DeleteReport = {
      deleted,
      files,
      results,
      partitions,
      blobsFailed,
      lakeSkipped,
      failures,
    };
    announce(summary(result));
    onDone?.(result);

    /* A clean sweep gets a toast and closes. Anything else keeps the dialog
       open with the whole report — a delete never claims more than it did. */
    if (isCleanSweep(result)) {
      toast(summary(result));
      setTyped("");
      onOpenChange(false);
      return;
    }
    setReport(result);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Delete {formatInt(count)} {count === 1 ? "test run" : "test runs"}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            This cannot be undone. Each run goes, with every file it registered and the bytes
            behind them, every signal row those files declared, every processed result, and the
            samples QuixLake holds under the run&rsquo;s partition folder. The journal keeps every
            entry the run ever had and gains a deletion entry.
          </DialogDescription>
        </DialogHeader>

        {/* Name the runs. A person must be able to read what they picked before
            a word arms the call. */}
        <div className="max-h-[132px] overflow-y-auto rounded-md border border-line bg-surface-2 px-3 py-2">
          <ul className="space-y-0.5">
            {runIds.map((runId) => (
              <li key={runId} className="font-mono text-[0.74rem] text-ink-2">
                {runId}
              </li>
            ))}
          </ul>
        </div>

        {actor === null && (
          <div
            role="alert"
            className="rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2"
          >
            {NO_ACTOR_MESSAGE}
          </div>
        )}

        {report === null && (
          <div>
            <label htmlFor="runs-delete-confirm" className="text-[0.76rem] font-medium text-ink-2">
              Type <span className="font-mono font-semibold">{CONFIRM_WORD}</span> to confirm
            </label>
            <Input
              id="runs-delete-confirm"
              autoFocus
              autoComplete="off"
              value={typed}
              disabled={running}
              placeholder={CONFIRM_WORD}
              className="mt-1 bg-surface-2 text-[0.82rem] focus-visible:bg-surface"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        )}

        {/* The live region stands before the batch starts, so a screen reader
            announces each step it reports. */}
        {report === null && (
          <div role="status" className="text-[0.76rem] text-ink-2">
            {running ? `Working — ${formatInt(sent ?? 0)} of ${formatInt(count)} deleted.` : ""}
          </div>
        )}

        {report !== null && (
          <div
            role="alert"
            className={`rounded-md border px-3 py-2 text-[0.76rem] text-ink-2 ${
              report.failures.length > 0
                ? "border-red-border bg-red-bg"
                : "border-amber-border bg-amber-bg"
            }`}
          >
            <p className="font-semibold">{summary(report)}</p>
            {report.blobsFailed > 0 && (
              <p className="mt-1.5">
                {formatInt(report.blobsFailed)}{" "}
                {report.blobsFailed === 1 ? "object" : "objects"} stayed in storage — the registry
                rows went anyway. The server log names every key.
              </p>
            )}
            {report.lakeSkipped > 0 && (
              <p className="mt-1.5">
                No lakehouse is configured here, so the samples of{" "}
                {formatInt(report.lakeSkipped)} {report.lakeSkipped === 1 ? "run" : "runs"} stay
                where they are.
              </p>
            )}
            {report.failures.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {report.failures.map((entry) => (
                  <li key={entry.runId}>
                    <span className="font-mono text-[0.74rem]">{entry.runId}</span> —{" "}
                    {entry.message}
                  </li>
                ))}
                <li className="pt-0.5">The failed runs stay picked, so you can try again.</li>
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={running} onClick={() => close(false)}>
            {report === null ? "Cancel" : "Done"}
          </Button>
          {report === null && (
            <Button
              size="sm"
              className={DESTRUCTIVE_CLASS}
              disabled={!armed || actor === null || running}
              onClick={() => void run()}
            >
              {running ? "Deleting…" : `Delete ${formatInt(count)} ${count === 1 ? "run" : "runs"}`}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
