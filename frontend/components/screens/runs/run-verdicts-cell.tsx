import { ToneBadge } from "@/components/shared/status-badge";
import type { RunVerdicts } from "@/types";

/**
 * The evaluation state of one run — how many of its definitions were judged,
 * and how it went. It sits beside the ingestion Status column, which says
 * only that the data arrived.
 *
 * Three readings, and they are three different sentences: a run carrying no
 * definition has nothing to judge, a run whose definitions carry no verdict
 * has not been evaluated, and everything else is a count and its split.
 */

const CHIPS = [
  { key: "pass", tone: "green", label: "pass" },
  { key: "fail", tone: "red", label: "fail" },
  { key: "error", tone: "amber", label: "error" },
] as const;

export function RunVerdictsCell({ verdicts }: { verdicts: RunVerdicts | undefined }) {
  if (verdicts === undefined) {
    return <span className="text-[0.78rem] text-ink-3">—</span>;
  }
  const judged = verdicts.pass + verdicts.fail + verdicts.error;
  const total = judged + verdicts.none;
  if (total === 0) {
    return <span className="text-[0.78rem] text-ink-3">No definitions</span>;
  }
  if (judged === 0) {
    return <span className="text-[0.78rem] text-ink-3">Not evaluated</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[0.78rem]">
        {judged} of {total}
      </span>
      {CHIPS.filter((chip) => verdicts[chip.key] > 0).map((chip) => (
        <ToneBadge key={chip.key} tone={chip.tone} dot>
          {verdicts[chip.key]} {chip.label}
        </ToneBadge>
      ))}
    </span>
  );
}
