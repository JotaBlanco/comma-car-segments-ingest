"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  StatusBadge,
  ToneBadge,
  type BadgeStatus,
} from "@/components/shared/status-badge";
import { useFiles, useRuns, useSearch, useSignals, useWorkOrders } from "@/lib/hooks";
import { formatBytes } from "@/lib/format";
import type { SearchGroupType, SearchItem } from "@/types";

const GROUP_LABELS: Record<SearchGroupType, string> = {
  test_runs: "Runs",
  work_orders: "Work orders",
  files: "Files",
  signals: "Signals",
  test_definitions: "Test definitions",
  processed_results: "Processed results",
};

const BADGE_STATUSES = new Set<string>([
  "complete",
  "awaiting_work_order",
  "invalid",
  "registered",
  "quarantined",
]);

function isBadgeStatus(status: string): status is BadgeStatus {
  return BADGE_STATUSES.has(status);
}

function hrefFor(type: SearchGroupType, item: SearchItem): string {
  switch (type) {
    case "test_runs":
      return `/runs/${encodeURIComponent(item.nav.run_id ?? item.id)}`;
    case "work_orders":
      return `/work-orders/${encodeURIComponent(item.nav.wo_id ?? item.id)}`;
    case "files":
      return `/files/${encodeURIComponent(item.nav.file_id ?? item.id)}`;
    case "signals":
      return `/signals/${encodeURIComponent(item.nav.name ?? item.id)}`;
    /* A definition and a result own no detail route. Each one opens the runs
       list the backend names in `nav` (contract #19). */
    case "test_definitions":
      return `/runs?definition=${encodeURIComponent(item.nav.definition ?? item.id)}`;
    case "processed_results": {
      const runId = item.nav.run_id ?? "";
      return runId.length > 0 ? `/runs/${encodeURIComponent(runId)}` : "/runs";
    }
  }
}

function ItemBadge({ status }: { status: string }) {
  if (isBadgeStatus(status)) {
    return <StatusBadge status={status} />;
  }
  return (
    <ToneBadge tone={status === "active" ? "green" : "neutral"} dot>
      {status.charAt(0).toUpperCase()}
      {status.slice(1).replaceAll("_", " ")}
    </ToneBadge>
  );
}

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("open-global-search", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("open-global-search", onOpenEvent);
    };
  }, []);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      setDebounced("");
    }
  };

  const trimmed = debounced.trim();
  /* Contract §19: the ⌘K overlay passes limit_per_group=4. */
  const { data, isError, isFetching } = useSearch(trimmed, { enabled: open, limitPerGroup: 4 });
  /* Empty-query default: top of each entity list, grouped like the prototype.
     The runs list polls hook-wide for the runs screen; the palette wants
     neither that poll nor any fetch while it is closed, so it asks for the
     list only while open and turns the interval off. */
  const { data: defaultRuns } = useRuns({ page_size: 10 }, { enabled: open, poll: false });
  // All four gate on `open` — three of them once fetched their top-10 lists
  // on EVERY page navigation with the palette closed (25 Aug 2026).
  const { data: defaultWos } = useWorkOrders({ page_size: 10 }, open);
  const { data: defaultFiles } = useFiles({ page_size: 10 }, { enabled: open });
  const { data: defaultSignals } = useSignals({ page_size: 10 }, { enabled: open });
  const groups = trimmed.length > 0 ? (data?.groups ?? []) : [];
  const showNoMatches =
    trimmed.length > 0 && data !== undefined && groups.length === 0;

  const select = (href: string) => {
    handleOpenChange(false);
    router.push(href);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Global search"
      description="Search runs, work orders, files, signals, test definitions and results"
      className="top-[22%] sm:max-w-xl"
    >
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search runs, work orders, files, signals, definitions, results…"
        />
        <CommandList className="max-h-[46vh]">
          {trimmed.length === 0 && (
            <>
              <CommandGroup heading="Test runs">
                {(defaultRuns?.items ?? []).slice(0, 4).map((run) => (
                  <CommandItem
                    key={`d-run:${run.run_id}`}
                    value={`d-run:${run.run_id}`}
                    onSelect={() => select(`/runs/${encodeURIComponent(run.run_id)}`)}
                  >
                    <span className="font-mono text-[0.76rem] font-semibold">{run.run_id}</span>
                    <span className="truncate text-[0.72rem] text-ink-3">
                      {run.description ?? "—"} · {run.rig_id}
                    </span>
                    <span data-slot="command-shortcut" className="ml-auto">
                      <StatusBadge status={run.status} />
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Work orders">
                {(defaultWos?.items ?? []).slice(0, 3).map((wo) => (
                  <CommandItem
                    key={`d-wo:${wo.wo_id}`}
                    value={`d-wo:${wo.wo_id}`}
                    onSelect={() => select(`/work-orders/${encodeURIComponent(wo.wo_id)}`)}
                  >
                    <span className="font-mono text-[0.76rem] font-semibold">{wo.wo_id}</span>
                    <span className="truncate text-[0.72rem] text-ink-3">
                      {wo.title} · {wo.project}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Files">
                {(defaultFiles?.items ?? []).slice(0, 3).map((file) => (
                  <CommandItem
                    key={`d-file:${file.file_id}`}
                    value={`d-file:${file.file_id}`}
                    onSelect={() => select(`/files/${encodeURIComponent(file.file_id)}`)}
                  >
                    <span className="font-mono text-[0.76rem] font-semibold">{file.filename}</span>
                    <span className="truncate text-[0.72rem] text-ink-3">
                      {file.run_id ?? "unlinked"} · {formatBytes(file.size_bytes)} · {file.source_system}
                    </span>
                    <span data-slot="command-shortcut" className="ml-auto">
                      {file.status === "quarantined" && <StatusBadge status="quarantined" />}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Signals">
                {(defaultSignals?.items ?? []).slice(0, 4).map((signal) => (
                  <CommandItem
                    key={`d-sig:${signal.name}`}
                    value={`d-sig:${signal.name}`}
                    onSelect={() => select(`/signals/${encodeURIComponent(signal.name)}`)}
                  >
                    <span className="font-mono text-[0.76rem] font-semibold">{signal.name}</span>
                    <span className="truncate text-[0.72rem] text-ink-3">
                      {signal.unit ?? "no unit"} · {signal.typical_rate_hz} Hz · {signal.run_count} runs
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          {/* Both states announce themselves — only the error branch below
              carried a live role, so "Searching…" and an empty result were
              silent to a screen reader. */}
          {showNoMatches && (
            <div role="status" className="px-4 py-7 text-center text-[0.78rem] text-ink-3">
              No matches for &ldquo;{trimmed}&rdquo;
            </div>
          )}
          {trimmed.length > 0 && data === undefined && isFetching && (
            <div role="status" className="px-4 py-7 text-center text-[0.78rem] text-ink-3">
              Searching…
            </div>
          )}
          {trimmed.length > 0 && isError && !isFetching && (
            <div role="alert" className="px-4 py-7 text-center text-[0.78rem] text-red">
              Search failed — check the connection and try again.
            </div>
          )}
          {groups.map((group) => (
            <CommandGroup key={group.type} heading={GROUP_LABELS[group.type]}>
              {group.items.map((item) => (
                <CommandItem
                  key={`${group.type}:${item.id}`}
                  value={`${group.type}:${item.id}`}
                  onSelect={() => select(hrefFor(group.type, item))}
                >
                  <span className="font-mono text-[0.76rem] font-semibold">
                    {item.id}
                  </span>
                  <span className="truncate text-[0.72rem] text-ink-3">
                    {item.sub}
                  </span>
                  <span data-slot="command-shortcut" className="ml-auto">
                    {item.status !== null && <ItemBadge status={item.status} />}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        <div className="flex items-center gap-3.5 border-t border-line-2 bg-surface-2 px-4 py-2 text-[0.68rem] text-ink-3">
          <span>
            <kbd className="rounded-[3px] border border-line bg-surface px-1 font-mono text-[0.64rem]">
              ↑↓
            </kbd>{" "}
            navigate
          </span>
          <span>
            <kbd className="rounded-[3px] border border-line bg-surface px-1 font-mono text-[0.64rem]">
              ↵
            </kbd>{" "}
            open
          </span>
          <span>
            <kbd className="rounded-[3px] border border-line bg-surface px-1 font-mono text-[0.64rem]">
              esc
            </kbd>{" "}
            close
          </span>
          {/* The old line said "every entity". The box never read every collection,
              and the set it reads changes, so the footer states only what stays true. */}
          <span className="ml-auto">one box — grouped by type</span>
        </div>
      </Command>
    </CommandDialog>
  );
}
