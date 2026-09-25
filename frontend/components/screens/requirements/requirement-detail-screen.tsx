"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Crumb, Crumbs } from "@/components/shared/crumbs";
import { EntityHistoryPanel, type JournalPanelParams } from "@/components/shared/entity-history-panel";
import { ErrorState } from "@/components/shared/error-state";
import { MetaCell, MetaGrid } from "@/components/shared/meta-grid";
import { Panel, PanelHead } from "@/components/shared/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { formatArrival } from "@/lib/format";
import { useRequirement, useRequirementJournal } from "@/lib/hooks";
import { requirementOrigin } from "@/types";
import { ChipList, MonoChip } from "./chip-list";
import { CoveringRunsPanel } from "./covering-runs-panel";
import { EditRequirementDialog } from "./edit-requirement-dialog";
import { RequirementTextPanel } from "./requirement-text-panel";
import { RetireRequirementDialog } from "./retire-requirement-dialog";
import { StatusControl, statusHint } from "./status-control";
import { VerificationChip } from "./verification-chip";

/**
 * The requirement detail — stacked panels, no tabs (spec §7). Panels A-F in
 * the spec's own order: header, requirement text, authored attributes,
 * verification (derived), covering runs, history.
 */

interface RequirementDetailScreenProps {
  reqId: string;
}

function ReqChipLink({ id }: { id: string }) {
  return (
    <Link href={`/requirements/${encodeURIComponent(id)}`} className="hover:underline">
      <MonoChip>{id}</MonoChip>
    </Link>
  );
}

export function RequirementDetailScreen({ reqId }: RequirementDetailScreenProps) {
  const { data: detail, isPending, error, refetch } = useRequirement(reqId);
  const [journalParams, setJournalParams] = useState<JournalPanelParams>({ page_size: 50 });
  const journalQuery = useRequirementJournal(reqId, journalParams);
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);

  if (error !== null) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <>
        <Crumbs>
          <Crumb type="Req" current>
            {reqId}
          </Crumb>
        </Crumbs>
        <Panel>
          <ErrorState
            message={notFound ? `Requirement ${reqId} not found.` : undefined}
            onRetry={notFound ? undefined : () => void refetch()}
          />
        </Panel>
      </>
    );
  }

  if (isPending) {
    return (
      <>
        <Crumbs>
          <Crumb type="Req" current>
            {reqId}
          </Crumb>
        </Crumbs>
        <div className="mb-[18px] space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Panel>
          <PanelHead title="Requirement text" />
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        </Panel>
      </>
    );
  }

  const origin = requirementOrigin(detail);
  const hint = statusHint(detail.status);

  return (
    <>
      <Crumbs>
        <Crumb type="Req" current>
          {detail.req_id}
        </Crumb>
      </Crumbs>

      {/* A. Header block */}
      <div className="mb-[18px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-[1.35rem] font-semibold tracking-[-0.01em]">
            {detail.req_id}
          </span>
          <StatusControl detail={detail} />
          <VerificationChip state={detail.verification_state} stale={detail.evidence_stale} />
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit metadata
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRetiring(true)}>
              Retire
            </Button>
          </div>
        </div>
        <div className="mt-[3px] text-[0.8rem] text-ink-3">
          {detail.title} · {detail.chapter ?? "—"} · {detail.ears_pattern ?? "—"}
        </div>
        <div className="mt-1.5">
          <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-3">
            {origin === "manual" ? "Authored in the Test Manager" : "Loaded by the catalogue seed"}
          </span>
        </div>
      </div>

      {/* B. Requirement text */}
      <RequirementTextPanel detail={detail} />

      {/* C. Authored attributes */}
      <Panel className="mb-3">
        <PanelHead
          title="Authored attributes"
          action={
            <span className="text-[0.7rem] text-ink-3">all authored fields</span>
          }
        />
        <MetaGrid>
          <MetaCell label="Status">
            {detail.status}
            {hint !== null && <p className="mt-1 text-[0.72rem] text-ink-3">{hint}</p>}
          </MetaCell>
          <MetaCell label="Verification method">{detail.verification_method ?? "—"}</MetaCell>
          <MetaCell label="Chapter">{detail.chapter ?? "—"}</MetaCell>
          <MetaCell label="EARS pattern">{detail.ears_pattern ?? "—"}</MetaCell>
          <MetaCell label="Revision (authored)">
            <span className="font-mono text-[0.78rem]">{detail.revision ?? "—"}</span>
          </MetaCell>
          <MetaCell label="System states">
            <ChipList
              items={detail.system_states}
              max={Infinity}
              renderItem={(value) => <MonoChip>{value}</MonoChip>}
            />
          </MetaCell>
          <MetaCell label="Measurands">
            <ChipList
              items={detail.measurand}
              max={Infinity}
              renderItem={(m) => <MonoChip>{`${m.name} (${m.unit})`}</MonoChip>}
            />
          </MetaCell>
          <MetaCell label="Source">
            <ChipList
              items={detail.source}
              max={Infinity}
              renderItem={(value) => <MonoChip>{value}</MonoChip>}
            />
          </MetaCell>
          <MetaCell label="Related requirements">
            <ChipList
              items={detail.related_reqs}
              max={Infinity}
              renderItem={(id) => <ReqChipLink id={id} />}
            />
          </MetaCell>
          {detail.verification_criteria !== null && (
            <MetaCell label="Verification criteria" className="col-span-4">
              {detail.verification_criteria}
            </MetaCell>
          )}
        </MetaGrid>
        {detail.rationale !== null && detail.rationale.length > 0 && (
          <div className="border-t border-line-2 px-4 py-3 text-[0.8rem] text-ink-2">
            {detail.rationale}
          </div>
        )}
      </Panel>

      {/* D. Verification (derived) */}
      <Panel className="mb-3">
        <PanelHead
          title="Verification"
          action={
            <span className="text-[0.7rem] text-ink-3">
              computed from runs and verdicts, never stored
            </span>
          }
        />
        <MetaGrid>
          <MetaCell label="Verification state">
            <VerificationChip state={detail.verification_state} />
          </MetaCell>
          <MetaCell label="Evidence">
            {detail.evidence_stale ? (
              <span className="text-amber">
                stale
                {(() => {
                  const since = detail.normative_changed_at ?? detail.synced_at;
                  return since !== null ? `, since ${formatArrival(since)}` : "";
                })()}
              </span>
            ) : (
              "current"
            )}
          </MetaCell>
          <MetaCell label="Verified by">
            <ChipList
              items={detail.verified_by}
              max={Infinity}
              renderItem={(td) => (
                <Link href={`/definitions/${encodeURIComponent(td)}`} className="hover:underline">
                  <MonoChip>{td}</MonoChip>
                </Link>
              )}
              emptyLabel="Not covered"
            />
          </MetaCell>
          <MetaCell label="Covering runs">
            <span className="font-mono text-[0.78rem]">{detail.covering_run_count}</span>
          </MetaCell>
          <MetaCell label="Latest run">
            {detail.latest_run_id === null ? (
              "—"
            ) : (
              <Link
                href={`/runs/${encodeURIComponent(detail.latest_run_id)}`}
                className="font-mono text-[0.78rem] hover:underline"
              >
                {detail.latest_run_id}
              </Link>
            )}
          </MetaCell>
          <MetaCell label="Tested at">
            {detail.tested_at !== null ? formatArrival(detail.tested_at) : "—"}
          </MetaCell>
          <MetaCell label="normative_sha256">
            <span className="font-mono text-[0.74rem]">{detail.normative_sha256.slice(0, 12)}</span>
          </MetaCell>
          <MetaCell label="normative_changed_at">
            {detail.normative_changed_at !== null ? formatArrival(detail.normative_changed_at) : "—"}
          </MetaCell>
        </MetaGrid>
      </Panel>

      {/* E. Runs covering this requirement */}
      <CoveringRunsPanel detail={detail} />

      {/* F. History — read-only in phase 1, no add-note (spec §7F). */}
      <EntityHistoryPanel
        label="requirement"
        isPending={journalQuery.isPending}
        isError={journalQuery.isError}
        page={journalQuery.data}
        onRetry={() => void journalQuery.refetch()}
        params={journalParams}
        onParamsChange={setJournalParams}
      />

      {editing && <EditRequirementDialog reqId={detail.req_id} onClose={() => setEditing(false)} />}
      <RetireRequirementDialog
        open={retiring}
        onOpenChange={setRetiring}
        rows={[{ req_id: detail.req_id, item_version: detail.item_version }]}
        onDone={() => setRetiring(false)}
      />
    </>
  );
}
