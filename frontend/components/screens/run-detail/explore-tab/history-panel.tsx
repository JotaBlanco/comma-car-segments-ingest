"use client";

/**
 * Query history panel — docked beside the workbench (pushes content; never an
 * overlay, per the approved mockup). Device-local, per run: Explore is
 * journal-free by decision D-E5, so this is convenience state, not registry
 * data, and the header says so.
 *
 * Saved (starred) entries group first and never evict; the rest group by day.
 */

import { memo, useEffect, useRef } from "react";
import {
  removeHistoryEntry,
  toggleSaved,
  useExploreHistory,
  type ExploreHistoryEntry,
} from "@/lib/explore/history-store";
import { MAX_EXPLORE_TABS } from "@/lib/explore/tabs";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface HistoryPanelProps {
  runId: string;
  onOpenInTab: (sql: string) => void;
  /** At the workbench tab cap a create is refused — disable instead of no-op. */
  openInTabDisabled?: boolean;
  onClose: () => void;
}

function dayLabel(at: number, now: Date): string {
  const date = new Date(at);
  const today = now.toDateString();
  if (date.toDateString() === today) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function copySql(sql: string): void {
  // Clipboard can be unavailable (permissions, insecure context) — the
  // try/catch takes the sync throw, the .catch the async denial.
  try {
    navigator.clipboard.writeText(sql).catch(() => {});
  } catch {
    // ignore
  }
}

const actionClass =
  "rounded-xs px-1.5 py-0.5 text-[0.66rem] text-ink-3 transition-colors hover:bg-accent-soft hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-3";

function Entry({
  runId,
  entry,
  onOpenInTab,
  openInTabDisabled,
}: {
  runId: string;
  entry: ExploreHistoryEntry;
  onOpenInTab: (sql: string) => void;
  openInTabDisabled: boolean;
}) {
  return (
    <li className="overflow-hidden rounded-md border border-line bg-surface transition-colors hover:border-line-strong">
      {entry.saved && entry.label !== undefined && (
        <div className="px-2.5 pt-1.5 text-[0.74rem] font-semibold">{entry.label}</div>
      )}
      <div className="overflow-hidden px-2.5 pt-1.5 pb-1 font-mono text-[0.7rem] text-ellipsis whitespace-nowrap text-ink-2">
        {entry.sql}
      </div>
      <div className="flex items-center gap-2 px-2.5 pb-1.5 text-[0.66rem] text-ink-3">
        <span
          aria-hidden
          className={cn(
            "size-1.5 flex-none rounded-full",
            entry.status === "ok" ? "bg-green-dot" : "bg-red-dot",
          )}
        />
        {entry.status === "ok" ? (
          <span className="font-mono">
            {entry.rowCount !== undefined ? `${formatInt(entry.rowCount)} rows` : "ok"}
            {entry.truncated === true && " (truncated)"}
            {entry.totalMs !== undefined && ` · ${Math.round(entry.totalMs)} ms`}
          </span>
        ) : (
          <span className="text-red">failed</span>
        )}
        <span className="font-mono">{timeLabel(entry.at)}</span>
        <span className="ml-auto flex items-center">
          <button
            type="button"
            className={actionClass}
            disabled={openInTabDisabled}
            // Same gate + wording as the tab strip's "+" menu.
            title={openInTabDisabled ? `Tab limit reached (${MAX_EXPLORE_TABS})` : undefined}
            onClick={() => onOpenInTab(entry.sql)}
          >
            Open in tab
          </button>
          <button type="button" className={actionClass} onClick={() => copySql(entry.sql)}>
            Copy
          </button>
          <button
            type="button"
            aria-pressed={entry.saved}
            aria-label={entry.saved ? "Unsave query" : "Save query"}
            className={cn(actionClass, entry.saved && "text-amber-dot")}
            onClick={() => toggleSaved(runId, entry.id)}
          >
            {entry.saved ? "★" : "☆"}
          </button>
          <button
            type="button"
            aria-label="Remove from history"
            className={cn(actionClass, "hover:bg-red-bg hover:text-red")}
            onClick={() => removeHistoryEntry(runId, entry.id)}
          >
            ×
          </button>
        </span>
      </div>
    </li>
  );
}

function GroupHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pt-2 pb-1.5 text-[0.62rem] font-bold tracking-[0.09em] text-ink-3 uppercase">
      {children}
    </div>
  );
}

export const HistoryPanel = memo(function HistoryPanel({
  runId,
  onOpenInTab,
  openInTabDisabled = false,
  onClose,
}: HistoryPanelProps) {
  const entries = useExploreHistory(runId);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Docked panel, not a dialog — but focus still moves in on open so the
  // keyboard lands where the user just headed. Esc is handled by the caller.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const saved = entries.filter((entry) => entry.saved);
  const recent = entries.filter((entry) => !entry.saved);
  const now = new Date();

  const groups: { label: string; items: ExploreHistoryEntry[] }[] = [];
  for (const entry of recent) {
    const label = dayLabel(entry.at, now);
    const group = groups[groups.length - 1];
    if (group !== undefined && group.label === label) group.items.push(entry);
    else groups.push({ label, items: [entry] });
  }

  return (
    <aside
      id="explore-history"
      role="region"
      aria-label="Query history"
      className="flex w-[380px] min-w-0 flex-none flex-col overflow-hidden rounded-md border border-line bg-surface shadow-tm"
    >
      <div className="flex flex-none items-center gap-2.5 border-b border-line-2 px-3.5 py-2">
        <span className="text-[0.72rem] font-bold tracking-[0.09em] uppercase">Query history</span>
        <span className="font-mono text-[0.66rem] text-ink-3">this run · this device</span>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close history"
          onClick={onClose}
          className="ml-auto grid size-6 place-items-center rounded-md text-ink-3 transition-colors hover:bg-accent-soft hover:text-primary"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {entries.length === 0 ? (
          <p className="px-2 py-6 text-center text-[0.76rem] text-ink-3">
            No queries yet — run one to see it here.
          </p>
        ) : (
          <>
            {saved.length > 0 && (
              <>
                <GroupHead>Saved · {saved.length}</GroupHead>
                <ul className="flex flex-col gap-1.5">
                  {saved.map((entry) => (
                    <Entry
                      key={entry.id}
                      runId={runId}
                      entry={entry}
                      onOpenInTab={onOpenInTab}
                      openInTabDisabled={openInTabDisabled}
                    />
                  ))}
                </ul>
              </>
            )}
            {groups.map((group) => (
              <div key={group.label}>
                <GroupHead>{group.label}</GroupHead>
                <ul className="flex flex-col gap-1.5">
                  {group.items.map((entry) => (
                    <Entry
                      key={entry.id}
                      runId={runId}
                      entry={entry}
                      onOpenInTab={onOpenInTab}
                      openInTabDisabled={openInTabDisabled}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
});
