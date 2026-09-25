import { ToneBadge, type BadgeTone } from "@/components/shared/status-badge";
import type { DefinitionVerdictState } from "@/types";

/**
 * What the runs decided about one test definition. It sits beside the
 * plan-adherence Status badge, the same two-badge treatment the requirements
 * grid gives a requirement (`screens/requirements/verification-chip.tsx`) —
 * different words, because a requirement's five-value Verification counts a
 * different unit.
 *
 * `error` is amber and never red: the evaluator could not decide, which is
 * not a failing test case (`dev-planning/test-results-page/spec.md` §3.3).
 */
const CONFIG: Record<DefinitionVerdictState, { label: string; tone: BadgeTone; dot: boolean }> = {
  not_run: { label: "Not run", tone: "neutral", dot: false },
  no_verdict: { label: "No verdict", tone: "neutral", dot: true },
  passed: { label: "Passed", tone: "green", dot: true },
  failed: { label: "Failed", tone: "red", dot: true },
  error: { label: "Error", tone: "amber", dot: true },
};

export function DefinitionVerdictChip({ state }: { state: DefinitionVerdictState | undefined }) {
  if (state === undefined) {
    return <span className="text-[0.78rem] text-ink-3">—</span>;
  }
  const config = CONFIG[state];
  return (
    <ToneBadge tone={config.tone} dot={config.dot}>
      {config.label}
    </ToneBadge>
  );
}
