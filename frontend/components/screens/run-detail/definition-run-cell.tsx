"use client";

import { ToneBadge, type BadgeTone } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { TableCell } from "@/components/ui/table";
import type { DefinitionVerdict } from "@/lib/api/definition-runs";
import { summariseEvidence, type RunView } from "@/lib/definition-run";
import { useDefinitionRun, useTestDefinition } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { VerdictOutcome } from "@/types";

const OUTCOME: Record<VerdictOutcome, { tone: BadgeTone; label: string }> = {
  pass: { tone: "green", label: "PASS" },
  fail: { tone: "red", label: "FAIL" },
  error: { tone: "amber", label: "ERROR" },
};

function VerdictLine({ verdict }: { verdict: DefinitionVerdict }) {
  const outcome = OUTCOME[verdict.outcome] ?? OUTCOME.error;
  return (
    <div className="flex min-w-0 items-center gap-2" role="status">
      <ToneBadge tone={outcome.tone} dot>
        {outcome.label}
      </ToneBadge>
      <span
        className="truncate font-mono text-[0.7rem] text-ink-3"
        title={JSON.stringify(verdict.evidence, null, 2)}
      >
        {summariseEvidence(verdict.evidence)}
      </span>
    </div>
  );
}

function RunStatus({ view }: { view: RunView }) {
  if (view.kind === "idle") return null;
  if (view.kind === "verdict") return <VerdictLine verdict={view.verdict} />;
  return (
    <div
      role="status"
      className={cn(
        "break-words font-mono text-[0.7rem]",
        view.kind === "failed" ? "text-red" : "text-ink-3",
      )}
    >
      {view.text}
    </div>
  );
}

/**
 * The Run control of one covered definition: its verdict on this run, and a button
 * that runs the definition's implementation as a QuixLab Job.
 *
 * The stored verdict is read only for a definition with an implementation, because
 * each read asks the Portal about the pair's Job first.
 */
export function DefinitionRunCell({ runId, tdId }: { runId: string; tdId: string }) {
  const definition = useTestDefinition(tdId);
  const runnable = (definition.data?.implementation?.blob_path ?? "").trim().length > 0;
  const control = useDefinitionRun(runId, tdId, runnable);
  const reason = definition.isLoading
    ? "Reading the definition…"
    : runnable
      ? "Runs the definition's implementation on this run as a QuixLab Job and records its verdict"
      : "This definition has no implementation to run";

  return (
    <TableCell className="whitespace-normal">
      <div className="flex items-center gap-3">
        <div className="min-w-0 max-w-[22rem] flex-1">
          <RunStatus view={control.view} />
        </div>
        <Button
          variant="outline"
          size="xs"
          className="font-semibold"
          disabled={control.pending || !runnable}
          aria-busy={control.pending}
          aria-label={`Run ${tdId} on this run`}
          title={reason}
          onClick={control.run}
        >
          {control.pending ? "Running…" : "Run"}
        </Button>
      </div>
    </TableCell>
  );
}
