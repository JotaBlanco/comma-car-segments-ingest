"use client";

import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { usePlanningSyncStatus, useToggleSync, useTriggerSync } from "@/lib/hooks";

export function PlanningSyncToggle() {
  const { data: status } = usePlanningSyncStatus();
  const toggleSync = useToggleSync();
  const triggerSync = useTriggerSync();

  const handleToggle = (checked: boolean) => {
    toggleSync.mutate(checked, {
      onSuccess: (result) => {
        if (result.online) {
          const summary = result.last_sync_result;
          toast.success(
            summary
              ? `Planning sync online — ${summary.work_orders} work orders mirrored, ${summary.runs_backfilled} run${summary.runs_backfilled === 1 ? "" : "s"} backfilled`
              : "Planning sync online",
          );
        } else {
          // The toggle stops the sync and deletes nothing. A message about a
          // run going back would describe a registry that un-remembers.
          toast("Planning sync offline — no new data arrives");
        }
      },
      onError: (error) => toast.error(`Planning sync toggle failed — ${error.message}`),
    });
  };

  const handleSyncNow = () => {
    // One FULL pass, switch untouched (`POST /planning-sync/trigger`): the
    // pull, then planning's adopting push — the server wakes an offline
    // planning for exactly this pass, so the button always does the same
    // thing the online worker does (24 Aug 2026). The toast narrates BOTH
    // halves; the pull-only sentence read identically on every press and
    // made the button look dead.
    triggerSync.mutate(undefined, {
      onSuccess: (result) => {
        const parts: string[] = [];
        const summary = result.last_sync_result;
        parts.push(
          summary ? `${summary.work_orders} work orders mirrored` : "pull ran",
        );
        const push = result.push;
        if (push?.pushed) {
          if (push.adopted?.length) {
            parts.push(`adopted ${push.adopted.join(", ")}`);
          }
          const links = push.links ?? 0;
          parts.push(`${links} link${links === 1 ? "" : "s"} posted`);
        } else if (push) {
          parts.push(`push declined — ${push.reason ?? "no reason given"}`);
        }
        toast.success(`Planning sync ran — ${parts.join(" · ")}`);
      },
      onError: (error) => toast.error(`Planning sync failed — ${error.message}`),
    });
  };

  return (
    <div
      className="flex items-center gap-2 rounded-md border border-dashed border-line bg-surface-2 px-2.5 py-1"
      title="Demo control — simulates the planning system coming online"
    >
      <label
        htmlFor="planning-sync-switch"
        className="text-[0.7rem] font-semibold tracking-[0.07em] text-ink-3 uppercase"
      >
        Planning sync
        {/* The wrapper's title reaches mouse hover only — the same sentence
            must reach keyboard and screen-reader users (FR-DM-091). */}
        <span className="sr-only">
          {" "}
          — demo control, simulates the planning system coming online
        </span>
      </label>
      <Switch
        id="planning-sync-switch"
        size="sm"
        checked={status?.online ?? false}
        onCheckedChange={handleToggle}
        disabled={toggleSync.isPending || status === undefined}
        aria-label="Toggle planning sync"
      />
      <button
        type="button"
        onClick={handleSyncNow}
        disabled={triggerSync.isPending || status === undefined}
        title="Run one sync pass now — the switch stays as it is"
        className="rounded-sm border border-line bg-surface px-2 py-[3px] text-[0.68rem] font-semibold text-ink-2 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50"
      >
        {triggerSync.isPending ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
