"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatInt } from "@/lib/format";
import { DeleteRunsDialog, DESTRUCTIVE_CLASS } from "./delete-runs-dialog";

/* The selection shape is `files/files-batch-bar.tsx`'s: the header box covers
   the page, a row box covers its row, and this bar reads the ids on screen and
   never the raw state. The ACTION is the opposite of that screen's — every
   action there keeps the bytes, and this one takes them — so the words live in
   `delete-runs-dialog.tsx`, which the run detail screen opens too. One delete,
   one set of words, one confirmation. */

interface RunsBatchBarProps {
  /** The picked run ids, in table order. Only rows on the page reach here. */
  readonly runIds: readonly string[];
  /** Clear the selection, or keep the runs a call refused. */
  onSelectionChange: (runIds: readonly string[]) => void;
}

export function RunsBatchBar({ runIds, onSelectionChange }: RunsBatchBarProps) {
  const [open, setOpen] = useState(false);
  const count = runIds.length;

  // A person who ticks nothing sees the screen exactly as it was.
  if (count === 0) return null;

  return (
    <>
      <div
        role="region"
        aria-label="Batch actions for the picked runs"
        className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[0.76rem] text-ink-3"
      >
        <span className="font-semibold text-ink-2">
          {formatInt(count)} {count === 1 ? "run" : "runs"} picked.
        </span>
        <Button variant="outline" size="sm" className={DESTRUCTIVE_CLASS} onClick={() => setOpen(true)}>
          <Trash2 className="size-[13px]" strokeWidth={2.2} />
          Delete
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onSelectionChange([])}>
          Clear
        </Button>
      </div>

      <DeleteRunsDialog
        open={open}
        onOpenChange={setOpen}
        runIds={runIds}
        /* Keep the refused runs picked, so a retry is one click. Nothing else
           stays: every deleted row has left the table already. */
        onDone={(report) => onSelectionChange(report.failures.map((entry) => entry.runId))}
      />
    </>
  );
}
