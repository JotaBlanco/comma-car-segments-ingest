/**
 * Server-hydrated entity card (AS-5) — reads like a real list row, because it
 * cites real rows. The reason quote carries a left red rule with the journal
 * actor and date: the flag, its actor and its timestamp are the record.
 *
 * Status wording follows the 19 Aug rename: a planning-linked run says
 * "Linked", never "Complete" (AI-SIDEBAR.md §4).
 */

import Link from "next/link";
import { StatusBadge } from "@/components/shared/status-badge";
import type { AssistantHit } from "@/types";
import { isAppRelativeUrl } from "./app-url";

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function HitCard({ hit }: { hit: AssistantHit }) {
  const linkable = isAppRelativeUrl(hit.url);
  const meta = [hit.rig_id, hit.first_data_at === null ? null : shortDate(hit.first_data_at)]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <div
      data-testid="assistant-hit"
      className="overflow-hidden rounded-md border border-line bg-surface shadow-tm [&+&]:-mt-px"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {linkable ? (
          <Link
            href={hit.url}
            className="font-mono text-[0.8rem] font-semibold text-primary hover:underline"
          >
            {hit.run_id}
          </Link>
        ) : (
          <span className="font-mono text-[0.8rem] font-semibold text-ink">{hit.run_id}</span>
        )}
        <StatusBadge
          status={hit.status}
          label={hit.status === "complete" ? "Linked" : undefined}
        />
        {meta.length > 0 && (
          <span className="ml-auto text-[0.68rem] whitespace-nowrap text-ink-3">{meta}</span>
        )}
      </div>
      {hit.reason !== null && (
        <div className="flex gap-2 px-3 pb-2 text-[0.76rem] text-ink-2">
          <span aria-hidden className="w-0.5 flex-none rounded-full bg-red-border" />
          <span className="flex-1">&ldquo;{hit.reason.text}&rdquo;</span>
          <span className="self-center text-[0.68rem] whitespace-nowrap text-ink-3">
            {hit.reason.actor} · {shortDate(hit.reason.at)}
          </span>
        </div>
      )}
    </div>
  );
}
