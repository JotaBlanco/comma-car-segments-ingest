"use client";

import { useState } from "react";
import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DESTRUCTIVE_CLASS } from "@/components/screens/runs/delete-runs-dialog";
import { RetireRequirementDialog, type RetirableRequirement } from "./retire-requirement-dialog";

/** Shaped on `runs-batch-bar.tsx` — the selection reads the ids on screen,
    never the raw filter state, so a row the table no longer shows can never
    take a retire. */
interface RequirementsBatchBarProps {
  readonly rows: readonly RetirableRequirement[];
  onSelectionChange: (reqIds: readonly string[]) => void;
}

export function RequirementsBatchBar({ rows, onSelectionChange }: RequirementsBatchBarProps) {
  const [open, setOpen] = useState(false);
  const count = rows.length;

  if (count === 0) return null;

  return (
    <>
      <div
        role="region"
        aria-label="Batch actions for the picked requirements"
        className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[0.76rem] text-ink-3"
      >
        <span className="font-semibold text-ink-2">
          {count} {count === 1 ? "requirement" : "requirements"} picked.
        </span>
        <Button variant="outline" size="sm" className={DESTRUCTIVE_CLASS} onClick={() => setOpen(true)}>
          <Archive className="size-[13px]" strokeWidth={2.2} />
          Retire
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onSelectionChange([])}>
          Clear
        </Button>
      </div>

      <RetireRequirementDialog
        open={open}
        onOpenChange={setOpen}
        rows={rows}
        onDone={(failedIds) => onSelectionChange(failedIds)}
      />
    </>
  );
}
