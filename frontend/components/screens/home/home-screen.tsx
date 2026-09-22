"use client";

import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatArrival, formatInt } from "@/lib/format";
import { useHomeSummary } from "@/lib/hooks";
import { FavouritesPanel } from "./favourites-panel";
import { NeedsAttentionPanel } from "./needs-attention-panel";
import { QuickActionsPanel } from "./quick-actions-panel";
import { RecentRunsPanel } from "./recent-runs-panel";
import { SavedSearchesPanel } from "./saved-searches-panel";
import { SourceBreakdownPanel } from "./source-breakdown-panel";

export function HomeScreen() {
  const { data, isPending, isError, refetch } = useHomeSummary();
  const counts = data?.counts;
  const lastSync = data?.planning_sync.last_sync_at;
  const skeleton = <Skeleton className="h-7 w-16" />;
  const retry = () => {
    void refetch();
  };

  return (
    <>
      <PageHeader
        title="Home"
        sub="Registry of runs, files and signals — system of record for anything a human decides."
      />

      <div className="mb-[22px] grid grid-cols-4 gap-3">
        {/* `isError` on every card: when the summary query fails the four cards
            used to sit on their skeletons for ever — a failure a presenter
            cannot tell from loading. The panels below carry the Retry. */}
        <StatCard
          label="Test runs"
          value={counts !== undefined ? formatInt(counts.test_runs) : skeleton}
          meta={counts !== undefined ? `+${counts.runs_today} today` : "—"}
          metaTone="up"
          isError={isError}
          href="/runs"
        />
        <StatCard
          label="Files registered"
          value={counts !== undefined ? formatInt(counts.files) : skeleton}
          meta={counts !== undefined ? `+${counts.files_today} today` : "—"}
          metaTone="up"
          isError={isError}
          href="/files"
        />
        <StatCard
          label="Signals cataloged"
          value={counts !== undefined ? formatInt(counts.signals) : skeleton}
          meta={
            counts !== undefined
              ? `across ${counts.rig_count} ${counts.rig_count === 1 ? "rig" : "rigs"}`
              : "—"
          }
          isError={isError}
          href="/signals"
        />
        <StatCard
          label="Work orders mirrored"
          value={counts !== undefined ? formatInt(counts.work_orders) : skeleton}
          meta={counts !== undefined ? `last sync: ${lastSync != null ? formatArrival(lastSync) : "—"}` : "—"}
          isError={isError}
          href="/work-orders"
        />
      </div>

      <div className="grid grid-cols-[1.6fr_1fr] items-start gap-3">
        <RecentRunsPanel
          runs={data?.recent_runs}
          isPending={isPending}
          isError={isError}
          onRetry={retry}
        />
        {/* The right column stacks the two panels: what needs a person, and
            where the metadata came from (TR-011). */}
        <div className="grid gap-3">
          <NeedsAttentionPanel
            attention={data?.needs_attention}
            rows={data?.attention_rows}
            isPending={isPending}
            isError={isError}
            onRetry={retry}
          />
          <SourceBreakdownPanel
            breakdown={data?.source_breakdown}
            isPending={isPending}
            isError={isError}
            onRetry={retry}
          />
        </div>
      </div>

      {/* Favourites, the saved searches and the upload action (FR-DM-075,
          FR-DM-017). Favourites are device-local, so that panel needs no query
          and never fails. Saved searches stack under Favorites in the wide left
          cell: both are tables of the same shape, and the narrow right cell cut
          their text off. Quick actions keeps the right cell, and keeps its own
          y, because it was already first in that cell. */}
      <div className="mt-3 grid grid-cols-[1.6fr_1fr] items-start gap-3">
        <div className="grid gap-3">
          <FavouritesPanel />
          <SavedSearchesPanel />
        </div>
        <QuickActionsPanel />
      </div>
    </>
  );
}
