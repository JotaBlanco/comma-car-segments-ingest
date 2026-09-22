import { ToneBadge, type BadgeTone } from "@/components/shared/status-badge";
import { cn } from "@/lib/utils";
import type { VerificationState } from "@/types";

/**
 * The five-value derived lifecycle (requirements-page spec §6). Colour is
 * reserved for this chip alone — the authored Status column stays one
 * neutral tone for every value, because the status enum is customer
 * configuration and this code cannot know which value is "good".
 */
const CONFIG: Record<VerificationState, { label: string; tone: BadgeTone; dot: boolean }> = {
  not_covered: { label: "Not covered", tone: "neutral", dot: false },
  covered: { label: "Covered", tone: "neutral", dot: true },
  exercised: { label: "Exercised", tone: "amber", dot: true },
  failed: { label: "Failed", tone: "red", dot: true },
  tested: { label: "Tested", tone: "green", dot: true },
};

export interface VerificationChipProps {
  state: VerificationState;
  /** Degrades a `tested` requirement's read without touching its tone —
      "the evidence aged" must never be misread as "the test failed". */
  stale?: boolean;
  className?: string;
}

export function VerificationChip({ state, stale = false, className }: VerificationChipProps) {
  const config = CONFIG[state];
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <ToneBadge tone={config.tone} dot={config.dot}>
        {config.label}
      </ToneBadge>
      {stale && (
        <ToneBadge tone="neutral" className="border border-dashed border-line bg-transparent">
          stale
        </ToneBadge>
      )}
    </span>
  );
}
