"use client";

import Link from "next/link";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { AddNoteButton, AddNoteDialog } from "@/components/shared/add-note-dialog";
import { Crumb, Crumbs } from "@/components/shared/crumbs";
import { EmptyState } from "@/components/shared/empty-state";
import {
  EntityHistoryPanel,
  type JournalPanelParams,
} from "@/components/shared/entity-history-panel";
import { ErrorState } from "@/components/shared/error-state";
import { FavouriteStar } from "@/components/shared/favourite-star";
import { LoadingRows } from "@/components/shared/loading-rows";
import { MetaCell, MetaGrid } from "@/components/shared/meta-grid";
import { Panel, PanelHead } from "@/components/shared/panel";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle, useRuns, useSignal, useSignalJournal, useSignalRunStats } from "@/lib/hooks";
import { sourced } from "@/types";
import { EditSignalDialog } from "./edit-signal-dialog";
import { formatDay, formatStat, optionalStat } from "./format";

const ROW_CLASS =
  "cursor-pointer transition-colors hover:bg-surface-2 focus-within:bg-surface-2";

interface SignalDetailScreenProps {
  name: string;
}

export function SignalDetailScreen({ name }: SignalDetailScreenProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  // The history panel drives the kind filter and the pager through these
  // params, and the journal hook re-queries with them (contract §8b).
  const [journalParams, setJournalParams] = useState<JournalPanelParams>({ page_size: 50 });
  const signalQuery = useSignal(name);
  const journalQuery = useSignalJournal(name, journalParams);
  /* The window title names the signal the moment it loads (FR-DM-091). */
  usePageTitle(signalQuery.data ? `${signalQuery.data.name} — signal` : null);
  /* Contract §16: the table lists invalid runs with their badge —
     only the aggregates exclude them. */
  /* The route defaults to 50 rows and the header counts every run. Ask for the
     largest page the contract allows, so the two agree on the real band. */
  const statsQuery = useSignalRunStats(name, { include_invalid: true, page_size: 200 });
  const runsQuery = useRuns({ signal: name, page_size: 100 });
  const signal = signalQuery.data;

  if (signalQuery.isPending) {
    return (
      <>
        <Skeleton className="mb-3.5 h-6 w-1/2" />
        <Skeleton className="mb-[18px] h-12 w-full" />
        <Panel>
          <table className="w-full">
            <tbody>
              <LoadingRows rows={6} cols={4} />
            </tbody>
          </table>
        </Panel>
      </>
    );
  }

  if (signalQuery.isError || signal === undefined) {
    return (
      <Panel>
        <ErrorState
          message={`Could not load signal ${name}.`}
          onRetry={() => void signalQuery.refetch()}
        />
      </Panel>
    );
  }

  const unit = sourced(signal, "unit");
  const runDescriptions = new Map(
    (runsQuery.data?.items ?? []).map((run) => [run.run_id, run.description ?? "—"])
  );
  const manuallyCorrectedUnit = unit.source === "manual" && signal.unit !== null;
  const catalogueMappedUnit = unit.source === "api:catalogue" && signal.unit !== null;
  const firstSeenDate = signal.first_seen.slice(0, 10);
  /* Two run counts answer two questions, so the screen never blends them.
     `run_count` counts the runs whose file inventory names the signal. The
     stats total counts the runs the lake holds samples for. A run can sit in
     the inventory and hold no sample, so the two differ by design. The header
     therefore names no number until the statistics arrive. */
  const statsRuns = statsQuery.data?.total;
  const statsTitle =
    statsRuns === undefined ? "Statistics per run" : `Statistics from ${statsRuns} runs`;

  return (
    <>
      <Crumbs>
        <Crumb type="Catalog" href="/signals">
          Signals
        </Crumb>
        <Crumb type="Signal" current>
          {signal.name}
        </Crumb>
      </Crumbs>

      <div className="mb-[18px] flex items-start gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-[1.35rem] font-semibold tracking-[-0.01em]">
              {signal.name}
            </h1>
            {signal.unit !== null ? (
              <ToneBadge tone="neutral">{signal.unit}</ToneBadge>
            ) : (
              <ToneBadge tone="amber" dot>
                missing unit
              </ToneBadge>
            )}
            <FavouriteStar type="signal" id={signal.name} label={signal.name} />
          </div>
          <div className="mt-[3px] text-[0.8rem] text-ink-3">
            {signal.description ?? "—"} · cataloged automatically at first ingestion, {firstSeenDate}
          </div>
        </div>
        <div className="ml-auto flex flex-none gap-2">
          <Button
            variant="outline"
            size="sm"
            className="font-semibold"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="size-[13px]" strokeWidth={2.2} aria-hidden />
            Edit catalog entry
          </Button>
          {/* No "Open in QuixLab" here. QuixLab opens one run, and this
              signal spans many. Each statistics row links to its run, and
              the run screen carries the control with the run id. */}
        </div>
      </div>

      <Panel>
        <PanelHead title="Signal metadata" />
        <MetaGrid>
          <MetaCell label="Unit">
            {signal.unit !== null ? (
              <>
                <span className="font-mono text-[0.78rem]">{signal.unit}</span>
                {manuallyCorrectedUnit && (
                  <div className="mt-px text-[0.72rem] font-normal text-ink-3">
                    unit was missing in file header — corrected
                    {unit.actor !== undefined && ` by ${unit.actor}`}
                    {unit.at !== undefined && `, ${formatDay(unit.at)}`}
                  </div>
                )}
                {catalogueMappedUnit && (
                  <div className="mt-px text-[0.72rem] font-normal text-ink-3">
                    mapped from the catalogue
                  </div>
                )}
              </>
            ) : (
              <>
                <ToneBadge tone="amber" dot>
                  missing
                </ToneBadge>
                <div className="mt-px text-[0.72rem] font-normal text-ink-3">
                  no unit in file — manual entry allowed
                </div>
              </>
            )}
          </MetaCell>
          <MetaCell label="Data type">
            <span className="font-mono text-[0.78rem]">{signal.dtype}</span>
          </MetaCell>
          <MetaCell label="Typical rate">
            <span className="font-mono text-[0.78rem]">{signal.typical_rate_hz} Hz</span>
          </MetaCell>
          <MetaCell label="Seen in">
            <span className="font-mono text-[0.78rem]">{signal.run_count} runs</span>
            <div className="mt-px text-[0.72rem] font-normal text-ink-3">
              the registry counts every run whose file inventory names this signal
            </div>
          </MetaCell>
          <MetaCell label="First seen">
            <span className="font-mono text-[0.78rem]">{formatDay(signal.first_seen)}</span>
          </MetaCell>
          <MetaCell label="Last seen">
            <span className="font-mono text-[0.78rem]">{formatDay(signal.last_seen)}</span>
          </MetaCell>
          <MetaCell
            label="Sensor ref"
            muted={signal.sensor_ref === null}
          >
            {signal.sensor_ref !== null ? (
              <>
                <span className="font-mono text-[0.78rem]">{signal.sensor_ref}</span>{" "}
                <span className="text-[0.72rem] font-normal text-ink-3">
                  rig sheet, {signal.rig_ids[0] ?? "—"}
                </span>
              </>
            ) : (
              "—"
            )}
          </MetaCell>
          <MetaCell
            label="Catalog entry"
            muted={signal.catalogue_ref === null}
          >
            {signal.catalogue_ref !== null ? (
              <span className="font-mono text-[0.78rem]">{signal.catalogue_ref}</span>
            ) : (
              "—"
            )}
          </MetaCell>
        </MetaGrid>
      </Panel>

      <Panel className="mt-3">
        <PanelHead
          title={
            <>
              <div>{statsTitle}</div>
              <div className="mt-px text-[0.72rem] font-normal text-ink-3">
                A run appears here when the lake holds samples for it. The registry lists
                this signal in {signal.run_count} runs.
              </div>
            </>
          }
          action={
            <Link
              href={`/runs?signal=${encodeURIComponent(signal.name)}`}
              className="text-[0.75rem] font-semibold text-primary"
            >
              View as run filter
            </Link>
          }
        />
        <table aria-label="Statistics per run" className="w-full">
          <thead>
            <tr>
              <th>Run</th>
              <th>Definition</th>
              <th>Rig</th>
              <th>Date</th>
              <th className="text-right!">Min</th>
              <th className="text-right!">Max</th>
              <th className="text-right!">Mean</th>
              <th className="text-right!">RMS</th>
              <th className="text-right!">p50</th>
              <th className="text-right!">p95</th>
              <th className="text-right!">p99</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {statsQuery.isPending && <LoadingRows rows={6} cols={12} />}
            {statsQuery.isError && (
              <tr>
                <td colSpan={12}>
                  <ErrorState
                    message="Could not load per-run statistics."
                    onRetry={() => void statsQuery.refetch()}
                  />
                </td>
              </tr>
            )}
            {statsQuery.isSuccess && statsQuery.data.items.length === 0 && (
              <tr>
                <td colSpan={12}>
                  <EmptyState
                    title="No run statistics"
                    message={`The lake holds no samples for this signal yet. The registry lists it in ${signal.run_count} runs.`}
                  />
                </td>
              </tr>
            )}
            {statsQuery.isSuccess &&
              statsQuery.data.items.map((stat) => {
                const description = runDescriptions.get(stat.run_id);
                const firstAppearance = stat.run_date === firstSeenDate;
                return (
                  <RowLink
                    key={stat.run_id}
                    variant="plain"
                    href={`/runs/${encodeURIComponent(stat.run_id)}`}
                    className={ROW_CLASS}
                  >
                    <td>
                      <RowLinkLabel>
                        <span className="font-mono text-[0.78rem]">{stat.run_id}</span>
                      </RowLinkLabel>
                      {(description !== undefined || firstAppearance) && (
                        <div className="mt-px text-[0.72rem] text-ink-3">
                          {description}
                          {firstAppearance && (
                            <>{description !== undefined && " · "}first appearance</>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      {stat.definition_id ? (
                        <Link
                          href={`/definitions/${encodeURIComponent(stat.definition_id)}`}
                          className="font-mono text-[0.78rem] hover:underline"
                        >
                          {stat.definition_id}
                        </Link>
                      ) : (
                        <span className="font-mono text-[0.78rem]">—</span>
                      )}
                    </td>
                    <td>
                      <span className="font-mono text-[0.78rem]">{stat.rig_id}</span>
                    </td>
                    <td>{formatDay(stat.run_date)}</td>
                    <td className="text-right font-mono text-[0.78rem]">
                      {formatStat(stat.min)}
                    </td>
                    <td className="text-right font-mono text-[0.78rem]">
                      {formatStat(stat.max)}
                    </td>
                    <td className="text-right font-mono text-[0.78rem]">
                      {formatStat(stat.mean)}
                    </td>
                    {/* The lake reads every sample of the run, so it computes
                        all four. A row the registry served can still leave
                        one blank: RMS merges over the files of a run and a
                        percentile does not. A dash means nobody measured it. */}
                    <td className="text-right font-mono text-[0.78rem]">
                      {optionalStat(stat.rms)}
                    </td>
                    <td className="text-right font-mono text-[0.78rem]">
                      {optionalStat(stat.p50)}
                    </td>
                    <td className="text-right font-mono text-[0.78rem]">
                      {optionalStat(stat.p95)}
                    </td>
                    <td className="text-right font-mono text-[0.78rem]">
                      {optionalStat(stat.p99)}
                    </td>
                    <td>
                      <StatusBadge status={stat.status} />
                    </td>
                  </RowLink>
                );
              })}
            {statsQuery.isSuccess && statsQuery.data.items.length > 0 && (
              <tr>
                <td colSpan={12} className="text-center text-[0.74rem] text-ink-3">
                  {statsQuery.data.items.length < statsQuery.data.total && (
                    <div className="mb-0.5 font-semibold text-ink-2">
                      Showing {statsQuery.data.items.length} of {statsQuery.data.total} runs.
                    </div>
                  )}
                  Per-run statistics computed lakeside — DuckDB aggregates the samples of
                  the registered MF4 files. No file download.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <EntityHistoryPanel
        className="mt-3"
        label="signal"
        isPending={journalQuery.isPending}
        isError={journalQuery.isError}
        page={journalQuery.data}
        onRetry={() => void journalQuery.refetch()}
        params={journalParams}
        onParamsChange={setJournalParams}
        action={<AddNoteButton onClick={() => setNoteOpen(true)} />}
      />

      <EditSignalDialog signal={signal} open={editOpen} onOpenChange={setEditOpen} />
      {/* Mounted on demand, like the edit dialogs of the other screens. */}
      {noteOpen && (
        <AddNoteDialog entityType="signal" entityId={name} open onOpenChange={setNoteOpen} />
      )}
    </>
  );
}
