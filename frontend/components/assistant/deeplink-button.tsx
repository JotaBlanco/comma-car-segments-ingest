/**
 * The payoff frame (AS-5): a validated deep link into a real filtered screen.
 * Stacked label + mono URL — the 384px panel is too narrow for side-by-side.
 *
 * Renders nothing unless the URL is app-relative (starts with "/"): the
 * backend only emits validated links, but the journal corpus is
 * attacker-writable (§5.3), so the FE refuses anything else too.
 */

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { AssistantDeeplink } from "@/types";
import { isAppRelativeUrl } from "./app-url";

export function DeeplinkButton({ deeplink }: { deeplink: AssistantDeeplink }) {
  if (!isAppRelativeUrl(deeplink.url)) return null;

  return (
    <Link
      href={deeplink.url}
      data-testid="assistant-deeplink"
      className="flex w-full flex-col gap-1 rounded-md border border-accent-soft-border bg-accent-soft px-3 py-2 text-left text-[0.78rem] font-semibold text-primary transition-colors hover:border-accent"
    >
      <span className="flex items-center gap-2">
        {/* An arrow, not the external-link mark. This link navigates in the
            same tab, and the external-link icon means "opens a new tab"
            everywhere else in the app. One icon, one meaning. */}
        <ArrowRight size={13} strokeWidth={2} aria-hidden />
        {deeplink.label}
      </span>
      <span className="truncate font-mono text-[0.68rem] font-medium text-ink-3">
        {deeplink.url}
      </span>
    </Link>
  );
}
