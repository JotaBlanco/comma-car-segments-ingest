"use client";

import Link from "next/link";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { IssueGeneral, IssueStateControl, StateBadge } from "@/components/screens/issues/issue-detail";
import { buttonVariants } from "@/components/ui/button";
import { snippetNote, snippetTags } from "@/lib/snippets/anomalies";
import { issueHref } from "@/lib/snippets/issue-link";
import { cn } from "@/lib/utils";
import type { DataSnippet } from "@/types";

/**
 * The issue a workbook was opened on, beside the dashboard.
 *
 * What a person needs while they look at the traces: what the issue says, what it names,
 * and the one control that changes anything — its state — at the top, where it is reached
 * without scrolling. It folds away to a spine, because the dashboard is the point and the
 * panel is the reference beside it.
 */
export function IssuePanel({
  snippet,
  runId,
  open,
  onOpenChange,
}: {
  snippet: DataSnippet;
  runId: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = snippetTags(snippet);
  if (!open) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-3 border-l border-line bg-surface py-2">
        <button
          type="button"
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
          onClick={() => onOpenChange(true)}
          aria-label="Show the issue"
          title="Show the issue"
        >
          <PanelRightOpen />
        </button>
        <span
          className="mt-1 text-[0.7rem] font-semibold tracking-wider text-ink-3 uppercase [writing-mode:vertical-rl]"
          title={snippet.name}
        >
          Issue
        </span>
      </aside>
    );
  }
  return (
    <aside className="flex w-[24rem] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[0.7rem] font-semibold tracking-wider text-ink-3 uppercase">Issue</span>
        <StateBadge state={t.state} />
        <span className="flex-1" />
        <IssueStateControl snippet={snippet} />
        <button
          type="button"
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
          onClick={() => onOpenChange(false)}
          aria-label="Hide the issue"
          title="Hide the issue"
        >
          <PanelRightClose />
        </button>
      </div>
      <div className="border-b border-line-2 px-3 py-2">
        <Link
          href={issueHref(snippet.id)}
          className="block truncate font-semibold text-ink-1"
          title={snippet.name}
        >
          {snippet.name}
        </Link>
        <p className="mt-0.5 line-clamp-2 text-[0.78rem] text-ink-3">
          {snippetNote(snippet.markdown)}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <IssueGeneral snippet={snippet} runId={runId} className="p-3" />
      </div>
    </aside>
  );
}
