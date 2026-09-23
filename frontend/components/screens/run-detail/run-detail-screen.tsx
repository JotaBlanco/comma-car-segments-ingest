"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { Crumb, Crumbs } from "@/components/shared/crumbs";
import {
  JournalKindFilter,
  type JournalPanelParams,
} from "@/components/shared/entity-history-panel";
import { ErrorState } from "@/components/shared/error-state";
import { FavouriteStar } from "@/components/shared/favourite-star";
import { JournalTimeline } from "@/components/shared/journal-timeline";
import { TablePager } from "@/components/shared/table-pager";
import { MetaCell, MetaGrid } from "@/components/shared/meta-grid";
import { NewTabMark } from "@/components/shared/new-tab-mark";
import { WorkbookMenu } from "@/components/shared/workbook-menu";
import { DeleteRunsDialog } from "@/components/screens/runs/delete-runs-dialog";
import { Panel, PanelHead } from "@/components/shared/panel";
import { SourceBadge } from "@/components/shared/source-badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { listNotebooks } from "@/lib/api/run-quixlab";
import { keys } from "@/lib/hooks/keys";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";
import { formatArrival, formatInt } from "@/lib/format";
import { usePageTitle, useRun, useRunJournal } from "@/lib/hooks";
import { quixLabConfigured } from "@/lib/quixlab";
import { claimTab, launchRunQuixLab } from "@/lib/run-quixlab";
import { cn } from "@/lib/utils";
import { sourced } from "@/types";
import type { SourceTag, TestRun } from "@/types";
import { AnomaliesTab } from "./anomalies-tab";
import { DefinitionsPanel } from "./definitions-panel";
import { EditRunDialog } from "./edit-run-dialog";
import { ExploreTab } from "./explore-tab/explore-tab";
import { FilesTab } from "./files-tab";
import { InvalidFlagDialog, type InvalidFlagMode } from "./invalid-flag-dialog";
import { FtsPanel } from "./fts-panel";
import { QuixLabPanel } from "./quixlab-panel";
import { ResultsTab } from "./results-tab";
import { RunNoteDialog } from "./run-note-dialog";
import { SignalsTab } from "./signals-tab";

/**
 * The run-detail tabs, in display order. The active one is a URL query param
 * (`?tab=…`, read/validated below) so a refresh or a shared link lands on the
 * same tab. The default (`signals`) is stripped from the URL, like
 * `lib/table-state.ts` strips default sort/page — plain `/runs/<id>` links stay
 * clean and identical states map to one URL.
 */
const RUN_DETAIL_TABS = [
  "signals",
  "files",
  "results",
  "notebooks",
  "anomalies",
  "journal",
  "explore",
] as const;
type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];
const DEFAULT_RUN_TAB: RunDetailTab = "signals";

function parseRunTab(raw: string | null): RunDetailTab {
  return (RUN_DETAIL_TABS as readonly string[]).includes(raw ?? "")
    ? (raw as RunDetailTab)
    : DEFAULT_RUN_TAB;
}

const timeWithSeconds = (iso: string | null) =>
  iso === null
    ? "—"
    : new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function FlagIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      className={className}
    >
      <path d="M4 15V4h13l-2 4 2 4H6" />
      <path d="M4 22v-7" />
    </svg>
  );
}

function PencilIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden
    >
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  );
}

/** Who set a field by hand, and when. A saved edit reads its own record here. */
function ManualBy({ actor, at }: { actor?: string; at?: string }) {
  if (actor === undefined) return null;
  return (
    <div className="mt-px text-[0.72rem] font-normal text-ink-3">
      set by hand by {actor}
      {at !== undefined && `, ${formatArrival(at)}`}
    </div>
  );
}

/* The active marker must sit on the seam between the strip and the card below.
   `components/ui/tabs.tsx` places it 5px lower, under `group-data-horizontal/tabs:`.
   A plain `after:bottom-0` carries a different variant prefix, so tailwind-merge
   keeps both classes and the prefixed one wins. The marker then landed inside
   the card, where the card's own background painted over it: the strip showed no
   active tab at all and it joined the table below by a bare gray line. The
   prefix here matches, so the offset is replaced instead of duplicated. The
   marker covers the strip's own bottom border, so the active tab joins the
   card and the card's top edge reads as one line with the header row. */
const tabTriggerClass =
  "flex-none px-3.5 py-[9px] text-[0.8rem] font-semibold text-ink-3 hover:text-ink-2 data-active:text-primary group-data-horizontal/tabs:after:bottom-[-1px] after:h-0.5 after:bg-primary";

/**
 * The empty state of a link the registry cannot honour yet.
 *
 * A run can carry the id the rig CLAIMED at ingest (`claimed_work_order_id`,
 * `claimed_definition_id`) while no such row exists here. Naming the claim is
 * the whole point of the state: it says which row has to exist before the link
 * closes. The claim is a claim, not a link, so it renders as muted text and
 * never as a link.
 */
function UnhonouredClaim({ claimedId }: { claimedId?: string | null }) {
  if (claimedId != null) {
    return (
      // text-ink-2, stated: the cell's inherited tone fails 4.5:1 in dark
      // at this size (axe color-contrast on the signals-tab scan).
      <span className="text-[0.7rem] text-ink-2">
        claimed <span className="font-mono">{claimedId}</span> · no such row here yet
      </span>
    );
  }
  return (
    <>
      — <span className="text-[0.7rem]">not linked</span>
    </>
  );
}

interface RunMetaField {
  key: string;
  label: string;
  source?: SourceTag;
  muted?: boolean;
  content: ReactNode;
}

/**
 * The eight metadata fields (label + source tag + rendered value), shared by
 * the wide 4-column MetadataPanel and the narrow Details ▾ overlay list so the
 * two presentations can never drift apart.
 */
function runMetaFields(run: TestRun): RunMetaField[] {
  const workOrder = sourced(run, "work_order_id");
  const definition = sourced(run, "definition_id");
  const rig = sourced(run, "rig_id");
  const testCell = sourced(run, "test_cell");
  const project = sourced(run, "project");
  const operator = sourced(run, "operator");
  const benchSw = sourced(run, "bench_sw");
  const startedAt = sourced(run, "started_at");
  // `definition_id` is the first of the covered set. The DefinitionsPanel lists
  // the whole set, so this cell states how many it is not showing.
  const otherDefinitions = Math.max((run.definition_ids ?? []).length - 1, 0);
  const embeddedFallback = (source: SourceTag | null, value: unknown): SourceTag | undefined =>
    source ?? (value !== null && value !== undefined ? "embedded" : undefined);

  return [
    {
      key: "work_order",
      label: "Work order",
      source: workOrder.source ?? undefined,
      muted: workOrder.value === null,
      content:
        workOrder.value !== null ? (
          <Link
            href={`/work-orders/${encodeURIComponent(workOrder.value)}`}
            className="font-mono text-[0.78rem] hover:underline"
          >
            {workOrder.value}
          </Link>
        ) : (
          <UnhonouredClaim claimedId={run.claimed_work_order_id} />
        ),
    },
    {
      key: "definition",
      label: "Test definition",
      source: definition.source ?? undefined,
      muted: definition.value === null,
      content:
        definition.value !== null ? (
          <>
            <Link
              href={`/definitions/${encodeURIComponent(definition.value)}`}
              className="font-mono text-[0.78rem] hover:underline"
            >
              {definition.value}
            </Link>
            {otherDefinitions > 0 && (
              <span className="ml-1.5 text-[0.72rem] text-ink-3">+{otherDefinitions} more</span>
            )}
          </>
        ) : (
          <UnhonouredClaim claimedId={run.claimed_definition_id} />
        ),
    },
    {
      key: "rig",
      label: "Rig",
      source: embeddedFallback(rig.source, rig.value),
      content: <span className="font-mono text-[0.78rem]">{run.rig_id}</span>,
    },
    {
      key: "test_cell",
      label: "Test cell",
      source: embeddedFallback(testCell.source, testCell.value),
      content: <span className="font-mono text-[0.78rem]">{run.test_cell ?? "—"}</span>,
    },
    {
      key: "project",
      label: "Project",
      source: project.source ?? undefined,
      muted: project.value === null,
      content: project.value ?? "—",
    },
    {
      key: "operator",
      label: "Operator",
      source: operator.source ?? undefined,
      muted: operator.value === null,
      content: (
        <>
          {operator.value ?? "—"}
          {operator.source === "manual" && <ManualBy actor={operator.actor} at={operator.at} />}
        </>
      ),
    },
    {
      key: "time_range",
      label: "Time range",
      source: embeddedFallback(startedAt.source, run.started_at),
      content: (
        <span className="font-mono text-[0.74rem]">
          {timeWithSeconds(run.started_at)} → {timeWithSeconds(run.ended_at)}
        </span>
      ),
    },
    {
      key: "bench_sw",
      label: "Bench SW at run time",
      source: benchSw.source ?? undefined,
      muted: benchSw.value === null,
      content: (
        <>
          {benchSw.value !== null ? (
            <span className="font-mono text-[0.78rem]">{benchSw.value}</span>
          ) : (
            "—"
          )}
          {benchSw.source === "manual" && <ManualBy actor={benchSw.actor} at={benchSw.at} />}
        </>
      ),
    },
  ];
}

function MetadataPanel({ run, onEdit }: { run: TestRun; onEdit: () => void }) {
  return (
    <Panel>
      <PanelHead
        title="Metadata"
        action={
          <span className="inline-flex items-center gap-2.5 text-[0.7rem] text-ink-3">
            every field carries its source — <SourceBadge source="embedded" />{" "}
            <SourceBadge source="api:planning" /> <SourceBadge source="manual" />
            {/* text-ink, stated: the outline variant has no text color of its
                own, so the button label inherits the legend's text-ink-3 —
                3.65:1 on the dark outline fill (axe color-contrast). */}
            <Button
              variant="outline"
              size="sm"
              className="font-semibold text-ink"
              onClick={onEdit}
            >
              <PencilIcon />
              Edit metadata
            </Button>
          </span>
        }
      />
      <MetaGrid>
        {runMetaFields(run).map((field) => (
          <MetaCell key={field.key} label={field.label} source={field.source} muted={field.muted}>
            {field.content}
          </MetaCell>
        ))}
      </MetaGrid>
      <CustomProperties run={run} />
    </Panel>
  );
}

/**
 * The run's custom properties, folded away behind a native disclosure.
 *
 * A run carries any number of free pairs, so they do not fit the fixed
 * 4-column grid above. `<details>` is keyboard reachable and it states its own
 * open state, so no script and no ARIA belong here. A run without a property
 * shows nothing at all — the panel keeps its shape for every other run.
 */
function CustomProperties({ run }: { run: TestRun }) {
  // The body comes off the network, so an older API build may send no key.
  const pairs = Object.entries(run.custom_properties ?? {});
  if (pairs.length === 0) return null;
  return (
    <details className="border-t border-line-2">
      <summary className="cursor-pointer px-4 py-[11px] text-[0.74rem] font-semibold text-ink-2 focus-visible:ring-2 focus-visible:ring-accent-fill focus-visible:outline-none">
        Custom properties ({pairs.length})
      </summary>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 px-4 pt-1 pb-3.5 text-[0.78rem]">
        {pairs.map(([key, value]) => (
          <Fragment key={key}>
            <dt className="text-ink-3">{key}</dt>
            <dd className="font-medium break-words">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

/**
 * Run actions — extracted so the same three controls render both in the
 * standard title row (non-Explore tabs) and inside the Explore slim bar's
 * Details ▾ dropdown. The overlay layout leads with the navigation actions and
 * pushes the destructive Mark-invalid to the far edge, mirroring the mockup.
 */
function RunActions({
  run,
  isInvalid,
  onMarkInvalid,
  onDelete,
  layout = "header",
}: {
  run: TestRun;
  isInvalid: boolean;
  onMarkInvalid: () => void;
  onDelete: () => void;
  layout?: "header" | "overlay";
}) {
  const markInvalid = !isInvalid && (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "font-semibold text-red hover:border-red-border hover:bg-red-bg hover:text-red",
        layout === "overlay" && "ml-auto"
      )}
      onClick={onMarkInvalid}
    >
      <FlagIcon />
      Mark invalid
    </Button>
  );
  const lineage = (
    // A styled Link, not a Button with a render prop: it navigates, so it must
    // keep link semantics (and Base UI warns on non-button render targets).
    <Link
      href={`/runs/${encodeURIComponent(run.run_id)}/lineage`}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "font-semibold")}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M12 3v6M7 15l5-6 5 6M7 15v6M17 15v6" />
      </svg>
      Lineage
    </Link>
  );
  const started = run.started_at ? Date.parse(run.started_at) : NaN;
  const ended = run.ended_at ? Date.parse(run.ended_at) : NaN;
  const workbook = (
    <WorkbookMenu
      run={run.run_id}
      explore={{
        run: run.run_id,
        frame:
          Number.isFinite(started) && Number.isFinite(ended) && ended > started
            ? { t0_ms: started, t1_ms: ended }
            : null,
      }}
    />
  );
  /* A delete is the one action here that cannot be undone. It sits LAST in the
     row and carries the red text every destructive control in this app carries
     (`files-batch-bar.tsx` states the tone rule), so it never reads as another
     way to look at the run. Colour is not the only signal: the word "Delete"
     says what it does, and the dialog behind it demands a typed word. */
  const remove = (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Delete run ${run.run_id}`}
      title="Delete this run"
      className="font-semibold text-red hover:border-red-border hover:bg-red-bg hover:text-red"
      onClick={onDelete}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" />
      </svg>
      Delete
    </Button>
  );
  /* A QuixLab of this viewer's own, for this run, made on the click.

     The gate stays `quixLabConfigured()`: a deployment with no QuixLab wiring
     has nothing to clone, and a control that answers 503 is worse than one
     that is not there. The URL itself is no longer where a person is sent —
     `lib/run-quixlab.ts` explains what happens to the tab instead. */
  const openLab = () => {
    const tab = claimTab();
    if (tab === null) {
      toast.error("Your browser blocked the new tab. Allow pop-ups for this site and try again.");
      return;
    }
    void launchRunQuixLab(run.run_id, tab).catch((error: unknown) => {
      const detail = error instanceof ApiError ? error.message : "QuixLab could not be started";
      tab.say(detail);
      toast.error(detail);
    });
  };
  const quixLab = quixLabConfigured() && (
    <Button size="sm" className="font-semibold" onClick={openLab}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M5 3l14 9-14 9V3z" />
      </svg>
      <span>Open in QuixLab</span>
      <NewTabMark iconClassName="size-3 opacity-80" />
    </Button>
  );
  if (layout === "overlay") {
    return (
      <>
        {lineage}
        {workbook}
        {quixLab}
        {markInvalid}
        {remove}
      </>
    );
  }
  return (
    <>
      {markInvalid}
      {lineage}
      {workbook}
      {quixLab}
      {remove}
    </>
  );
}

function MetaSep() {
  return <span className="text-line-strong">·</span>;
}

/**
 * Slim run bar (Explore focus layout) — collapses the run header + Metadata
 * panel into a single ~46px strip. The full metadata + actions live in a
 * Details ▾ overlay dropdown that floats over the Explore frame, so opening it
 * never shifts the page.
 */
function SlimRunBar({
  run,
  isInvalid,
  detailsOpen,
  onToggleDetails,
  onMarkInvalid,
  onDelete,
}: {
  run: TestRun;
  isInvalid: boolean;
  detailsOpen: boolean;
  onToggleDetails: (open: boolean) => void;
  onMarkInvalid: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative z-30 flex h-[46px] flex-none items-center gap-2.5 border-b border-line bg-surface px-5">
      <Link
        href="/runs"
        className="whitespace-nowrap text-[0.75rem] text-ink-3 hover:text-primary hover:underline"
      >
        Test runs
      </Link>
      <span className="text-[0.75rem] text-line-strong">/</span>
      {/* The slim bar replaces the standard header on the Explore layout, so
          the one h1 of that view lives here (FR-DM-091). */}
      <h1 className="font-mono text-[0.95rem] font-semibold tracking-[-0.01em] whitespace-nowrap">
        {run.run_id}
      </h1>
      <StatusBadge status={run.status} />
      {isInvalid && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-bg px-2.5 py-[3px] text-[0.68rem] font-semibold text-red">
          <FlagIcon size={11} />
          Invalid
        </span>
      )}
      <div className="flex min-w-0 items-center gap-[7px] overflow-hidden whitespace-nowrap text-[0.75rem] text-ink-2">
        <span className="font-mono text-[0.72rem]">{run.rig_id}</span>
        {run.test_cell !== null && (
          <>
            <MetaSep />
            <span className="font-mono text-[0.72rem]">{run.test_cell}</span>
          </>
        )}
        <MetaSep />
        <span className="font-mono text-[0.72rem]">
          {timeWithSeconds(run.started_at)} → {timeWithSeconds(run.ended_at)}
        </span>
        {run.work_order_id !== null && (
          <>
            <MetaSep />
            <span className="font-mono text-[0.72rem]">{run.work_order_id}</span>
          </>
        )}
        <MetaSep />
        <span>
          {run.file_count} files · {formatInt(run.signal_count)} signals
        </span>
      </div>

      <div className="relative ml-auto flex-none">
        {/* Base UI Popover replaces the hand-rolled role="dialog" (FR-DM-090):
            it brings the focus trap, Escape-to-close and focus restore the
            hand-rolled card never had, plus outside-click close without the
            aria-hidden button backdrop. */}
        <Popover open={detailsOpen} onOpenChange={onToggleDetails}>
          <PopoverTrigger
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[0.74rem] font-semibold whitespace-nowrap transition-colors",
              detailsOpen
                ? "border-accent-soft-border bg-accent-soft text-primary"
                : "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink"
            )}
          >
            Details
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
              className={cn("transition-transform", detailsOpen && "rotate-180")}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </PopoverTrigger>
          {/* One cohesive popover card: header → key/value list → action
              footer. The narrow overlay gets a purpose-built definition list
              instead of the wide 4-column MetaGrid, so labels never wrap. */}
          <PopoverContent
            align="end"
            sideOffset={8}
            aria-label="Run details"
            className="w-[min(480px,calc(100vw-40px))] gap-0 overflow-hidden rounded-md border border-line bg-surface p-0 shadow-tm-lg"
          >
            <div className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-[9px]">
              <span className="text-[0.8rem] font-bold tracking-[-0.01em]">Run details</span>
              <span className="inline-flex items-center gap-1.5 text-[0.66rem] whitespace-nowrap text-ink-3">
                sources <SourceBadge source="embedded" /> <SourceBadge source="api:planning" />{" "}
                <SourceBadge source="manual" />
              </span>
            </div>
            <dl className="max-h-[min(420px,calc(100dvh-240px))] overflow-y-auto py-1.5">
              {runMetaFields(run).map((field) => (
                <div
                  key={field.key}
                  className="grid grid-cols-[148px_1fr] items-baseline gap-x-4 px-4 py-[7px]"
                >
                  <dt className="text-[0.63rem] font-semibold tracking-[0.08em] whitespace-nowrap text-ink-3 uppercase">
                    {field.label}
                  </dt>
                  <dd className="flex min-w-0 items-baseline justify-between gap-3 text-[0.8rem] font-medium">
                    <span className={cn("min-w-0", field.muted && "text-ink-3")}>
                      {field.content}
                    </span>
                    {field.source !== undefined && (
                      <SourceBadge source={field.source} className="flex-none" />
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex items-center gap-2 border-t border-line-2 bg-surface-2 px-4 py-2.5">
              <RunActions
                run={run}
                isInvalid={isInvalid}
                onMarkInvalid={onMarkInvalid}
                onDelete={onDelete}
                layout="overlay"
              />
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function JournalTab({ runId, onAddNote }: { runId: string; onAddNote: () => void }) {
  /* The same controlled params the entity history panels use: the kind filter
     and the pager write them, and the journal hook re-queries (contract §8).
     The controls render outside the pending branch, so a kind flip never
     unmounts the control a person just pressed. */
  const [params, setParams] = useState<JournalPanelParams>({ page_size: 50 });
  const journalQuery = useRunJournal(runId, params);
  const controls = (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
      <JournalKindFilter
        aria-label="Filter the run journal by kind"
        kind={params.kind}
        onKindChange={(kind) => setParams((previous) => ({ ...previous, kind, page: 1 }))}
      />
      <Button variant="outline" size="sm" className="font-semibold" onClick={onAddNote}>
        <PencilIcon />
        Add note
      </Button>
    </div>
  );
  if (journalQuery.isPending) {
    return (
      <>
        {controls}
        <div className="space-y-4 p-5">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex gap-3.5">
              <Skeleton className="size-[22px] rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }
  if (journalQuery.isError) {
    return (
      <>
        {controls}
        <ErrorState
          message="Could not load the journal."
          onRetry={() => void journalQuery.refetch()}
        />
      </>
    );
  }
  const page = journalQuery.data;
  return (
    <>
      {controls}
      {page.items.length === 0 && params.kind !== undefined ? (
        /* Entries exist, just not this kind — the plain empty state would
           claim an empty journal and lie. */
        <div className="px-5 py-8 text-center text-[0.78rem] text-ink-3">
          No {params.kind} entries in the journal of this run.
        </div>
      ) : (
        <JournalTimeline entries={page.items} />
      )}
      {page.total > 0 && (
        <TablePager
          page={page.page}
          pageSize={page.page_size}
          total={page.total}
          totalPages={page.total_pages}
          onPageChange={(nextPage) => setParams((previous) => ({ ...previous, page: nextPage }))}
          onPageSizeChange={(size) =>
            setParams((previous) => ({ ...previous, page_size: size, page: 1 }))
          }
        />
      )}
    </>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="mb-3.5 flex items-center gap-[7px]">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-6 w-28" />
      </div>
      <div className="mb-[18px] flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>
      <Panel>
        <PanelHead title="Metadata" />
        <div className="grid grid-cols-4 gap-4 p-4">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-4 w-28" />
            </div>
          ))}
        </div>
      </Panel>
      <Skeleton className="mt-[22px] h-10 w-full" />
      <Skeleton className="mt-2 h-48 w-full" />
    </div>
  );
}

export function RunDetailScreen({ runId }: { runId: string }) {
  const runQuery = useRun(runId);
  /* The window title names the run the moment it loads (FR-DM-091). */
  usePageTitle(runQuery.data ? `${runQuery.data.run_id} — test run` : null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `null` closes the flag dialog. "raise" opens it to flag, "clear" to unflag.
  const [flagMode, setFlagMode] = useState<InvalidFlagMode | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Tabs are controlled so the Explore tab can drive the focus layout while
  // every other tab keeps the standard run-detail layout. Same values/order as
  // the uncontrolled version, so a11y + e2e tab loops are unaffected. The
  // value itself lives in the URL (`?tab=…`) so a refresh keeps the tab open;
  // invalid/missing values fall back to the default.
  const activeTab = parseRunTab(searchParams.get("tab"));
  /* How many data snippets the Anomalies tab found, once it has looked: the tab writes
     it, the strip shows it. Null until then, so the strip shows no number it cannot vouch
     for (the count comes from the lake, not from the run record). */
  const [snippetCount, setSnippetCount] = useState<number | null>(null);
  // Full-screen Explore focus mode (⇧F / Esc), toggled from inside ExploreTab.
  const [focus, setFocus] = useState(false);
  // Details ▾ overlay in the Explore slim bar.
  const [detailsOpen, setDetailsOpen] = useState(false);
  /* The signals a person picks on the Signals tab, and sends to QuixLab. It
     sits here because this screen is the only parent the Signals tab and the
     QuixLab panel share — the tab writes it, the panel reads it. An EMPTY
     list means the whole run, which is what the frame always opened. */
  const [pickedSignals, setPickedSignals] = useState<string[]>([]);
  /* How many signal rows the Signals tab shows once its filters run, or null
     while no filter is on. The strip below must never print a count larger
     than the table under it. */
  const [shownSignals, setShownSignals] = useState<number | null>(null);

  /* "Open in → New QuixLab notebook" arrives as `?tab=notebooks&notebook=new`; the
     Notebooks tab creates one and hands the request back, which clears it from the URL. */
  const createNotebookRequested = activeTab === "notebooks" && searchParams.get("notebook") === "new";
  const onCreateHandled = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.delete("notebook");
    const query = params.toString();
    router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchParams, router, pathname]);
  const notebooks = useQuery({
    queryKey: keys.runs.notebooks(runId),
    queryFn: () => listNotebooks(runId),
  });

  const onTabChange = useCallback(
    (value: string) => {
      const tab = parseRunTab(value);
      // `replace`, not `push` — tab flips are view state, and stepping the
      // back button through every visited tab would be history spam. The
      // default tab is stripped so plain `/runs/<id>` links stay canonical.
      const params = new URLSearchParams(searchParams);
      if (tab === DEFAULT_RUN_TAB) params.delete("tab");
      else params.set("tab", tab);
      const query = params.toString();
      router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  // The focus layout + Details overlay only make sense on the Explore tab —
  // leaving it (by click, back/forward or an edited URL) always drops back to
  // the standard, page-scrolling layout. An effect rather than the change
  // handler so URL-driven tab changes reset it too.
  useEffect(() => {
    if (activeTab !== "explore") {
      setFocus(false);
      setDetailsOpen(false);
    }
  }, [activeTab]);

  /* Focus mode (⇧F) covers the viewport, but the topbar, the sidebar and the
     assistant panel stayed in the DOM behind it — still in the tab order, so
     a keyboard user tabbed through invisible chrome (FR-DM-090). `inert`
     takes the hidden chrome out of both the tab order and the accessibility
     tree. Prior state is restored on exit, because the assistant panel
     manages its own `inert` while closed. */
  useEffect(() => {
    if (!(activeTab === "explore" && focus)) return undefined;
    const root = document.documentElement;
    /* The assistant reads this and refuses ⌘J while focus mode is up, so the
       panel cannot open behind the cover and desync the restore below. */
    root.dataset.exploreFocus = "1";
    const chrome = Array.from(document.querySelectorAll<HTMLElement>("[data-shell-chrome]"));
    /* Only take over an element that is not already inert, and only give back
       what we took. The assistant panel declares `inert={!open}` itself: it is
       already inert while closed, so restoring a captured `true` used to hand
       an OPEN panel back inert — and React never re-applied the prop, because
       its value had not changed. The panel then stayed open and dead. */
    const taken = chrome.filter((element) => !element.inert);
    for (const element of taken) element.inert = true;
    return () => {
      delete root.dataset.exploreFocus;
      for (const element of taken) element.inert = false;
    };
  }, [activeTab, focus]);

  if (runQuery.isPending) return <LoadingSkeleton />;

  if (runQuery.isError) {
    if (runQuery.error instanceof ApiError && runQuery.error.status === 404) {
      return (
        <div className="py-16 text-center">
          <div className="font-mono text-[0.9rem] font-semibold">Run not found</div>
          <div className="mt-1 text-[0.78rem] text-ink-3">
            No test run <span className="font-mono">{runId}</span> in the registry.
          </div>
          <Link
            href="/runs"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}
          >
            Back to runs
          </Link>
        </div>
      );
    }
    return (
      <ErrorState message="Could not load this run." onRetry={() => void runQuery.refetch()} />
    );
  }

  const run = runQuery.data;
  const isInvalid = run.invalid.flagged;
  const exploreActive = activeTab === "explore";

  return (
    <div
      className={cn(
        // Explore (normal): break out of AppShell's centered max-w-[1280px]
        // column + page padding by pinning to the shell's content area — flush
        // under the 52px topbar, and between the sidebar and the assistant
        // dock, both of which publish their width as a CSS variable. The split
        // gets the rest of the content width and every pane scrolls internally.
        exploreActive && !focus && cn(SHELL_BREAKOUT_CLASS, "bg-bg"),
        // Explore (focus): cover the whole viewport, chrome included.
        exploreActive && focus && "fixed inset-0 z-50 flex min-h-0 flex-col bg-bg"
      )}
    >
      {exploreActive ? (
        <SlimRunBar
          run={run}
          isInvalid={isInvalid}
          detailsOpen={detailsOpen}
          onToggleDetails={setDetailsOpen}
          onMarkInvalid={() => setFlagMode("raise")}
          onDelete={() => setDeleteOpen(true)}
        />
      ) : (
        <StandardRunHeader
          run={run}
          isInvalid={isInvalid}
          onMarkInvalid={() => setFlagMode("raise")}
          onClearInvalid={() => setFlagMode("clear")}
          onEdit={() => setEditOpen(true)}
          onDelete={() => setDeleteOpen(true)}
          signals={pickedSignals}
        />
      )}

      <Tabs
        value={activeTab}
        onValueChange={onTabChange}
        className={cn(exploreActive ? "flex min-h-0 flex-1 flex-col gap-0" : "mt-[22px] gap-0")}
      >
        <TabsList
          variant="line"
          className={cn(
            "z-10 h-auto w-full justify-start gap-0.5 rounded-none border-b border-line p-0",
            exploreActive && focus && "hidden"
          )}
        >
          <TabsTrigger value="signals" className={tabTriggerClass}>
            Signals{" "}
            <span className="font-mono text-[0.68rem] text-ink-3">
              {formatInt(shownSignals ?? run.signal_count)}
            </span>
          </TabsTrigger>
          <TabsTrigger value="files" className={tabTriggerClass}>
            Files <span className="font-mono text-[0.68rem] text-ink-3">{run.file_count}</span>
          </TabsTrigger>
          <TabsTrigger value="results" className={tabTriggerClass}>
            Processed results{" "}
            <span className="font-mono text-[0.68rem] text-ink-3">{run.result_count}</span>
          </TabsTrigger>
          <TabsTrigger value="notebooks" className={tabTriggerClass}>
            Notebooks{" "}
            {notebooks.data !== undefined && (
              <span className="font-mono text-[0.68rem] text-ink-3">{notebooks.data.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="anomalies" className={tabTriggerClass}>
            Issues{" "}
            {snippetCount !== null && (
              <span className="font-mono text-[0.68rem] text-ink-3">{formatInt(snippetCount)}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="journal" className={tabTriggerClass}>
            Journal <span className="font-mono text-[0.68rem] text-ink-3">{run.journal_count}</span>
          </TabsTrigger>
          <TabsTrigger value="explore" className={tabTriggerClass}>
            Explore
          </TabsTrigger>
        </TabsList>
        <div
          className={cn(
            exploreActive
              ? "flex min-h-0 flex-1 flex-col"
              : "rounded-b-md border border-t-0 border-line bg-surface"
          )}
        >
          <TabsContent value="signals">
            <SignalsTab
              runId={run.run_id}
              signalCount={run.signal_count}
              selected={pickedSignals}
              onSelectedChange={setPickedSignals}
              onShownCountChange={setShownSignals}
            />
          </TabsContent>
          <TabsContent value="files">
            <FilesTab runId={run.run_id} />
          </TabsContent>
          <TabsContent value="results">
            <ResultsTab runId={run.run_id} />
          </TabsContent>
          <TabsContent value="notebooks">
            {/* The run's QuixLab notebooks, on the pick from the Signals tab. */}
            <QuixLabPanel
              runId={run.run_id}
              signals={pickedSignals}
              flat
              createOnMount={createNotebookRequested}
              onCreateHandled={onCreateHandled}
            />
          </TabsContent>
          <TabsContent value="anomalies">
            <AnomaliesTab runId={run.run_id} onCountChange={setSnippetCount} />
          </TabsContent>
          <TabsContent value="journal">
            <JournalTab runId={run.run_id} onAddNote={() => setNoteOpen(true)} />
          </TabsContent>
          <TabsContent
            value="explore"
            className={cn(exploreActive && "flex min-h-0 flex-1 flex-col outline-none")}
          >
            <ExploreTab runId={run.run_id} focus={focus} onToggleFocus={() => setFocus((on) => !on)} />
          </TabsContent>
        </div>
      </Tabs>

      {flagMode !== null && (
        <InvalidFlagDialog
          runId={run.run_id}
          mode={flagMode}
          open
          onOpenChange={(open) => {
            if (!open) setFlagMode(null);
          }}
        />
      )}
      <EditRunDialog run={run} open={editOpen} onOpenChange={setEditOpen} />
      {/* Mounted on demand, like the flag dialog above. */}
      {noteOpen && <RunNoteDialog runId={run.run_id} open onOpenChange={setNoteOpen} />}
      {/* The same dialog the runs table's batch bar opens, on a list of one —
          one delete, one confirmation, one set of words. Mounted only while it
          is open, as the note dialog is. A run that really went takes this
          screen with it: the page reads a record that no longer exists, so
          staying would render a 404. A delete that failed keeps the dialog
          open with the reason. */}
      {deleteOpen && (
        <DeleteRunsDialog
          open
          onOpenChange={setDeleteOpen}
          runIds={[run.run_id]}
          onDone={(report) => {
            if (report.deleted > 0) router.replace("/runs");
          }}
        />
      )}
    </div>
  );
}

/**
 * The standard run header (title + description + actions + Metadata panel) used
 * by every tab except Explore.
 */
function StandardRunHeader({
  run,
  isInvalid,
  onMarkInvalid,
  onClearInvalid,
  onEdit,
  onDelete,
  signals,
}: {
  run: TestRun;
  isInvalid: boolean;
  onMarkInvalid: () => void;
  onClearInvalid: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** The signals picked on the Signals tab. Empty means the whole run. */
  signals: readonly string[];
}) {
  return (
    <>
      <Crumbs>
        {run.work_order_id !== null ? (
          <Crumb type="WO" href={`/work-orders/${encodeURIComponent(run.work_order_id)}`}>
            {run.work_order_id}
          </Crumb>
        ) : (
          <Crumb type="WO" missing>
            {run.claimed_work_order_id != null
              ? `claimed ${run.claimed_work_order_id} · no such row here yet`
              : "not linked"}
          </Crumb>
        )}
        {run.definition_id !== null ? (
          <Crumb
            type="Def"
            href={`/definitions/${encodeURIComponent(run.definition_id)}`}
          >
            {run.definition_id}
          </Crumb>
        ) : (
          <Crumb type="Def" missing>
            {run.claimed_definition_id != null
              ? `claimed ${run.claimed_definition_id} · no such row here yet`
              : "not linked"}
          </Crumb>
        )}
        <Crumb type="Run" current>
          {run.run_id}
        </Crumb>
      </Crumbs>

      {isInvalid && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2.5 rounded-md border border-red-border bg-red-bg px-3.5 py-[11px] text-[0.8rem]"
        >
          <FlagIcon size={16} className="mt-px flex-none text-red" />
          <div>
            <b className="text-red">Flagged invalid</b> by{" "}
            <span className="font-mono text-[0.72rem] text-ink-2">{run.invalid.actor}</span>
            {run.invalid.at !== null && <> · {formatArrival(run.invalid.at)}</>}
            <br />
            <span className="text-[0.78rem]">{run.invalid.reason}</span>
          </div>
          {/* The flag is reversible. Without this control a flag raised in a
              rehearsal stands for ever. The dialog asks for a reason, so the
              step is a confirmation and not a single click. */}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto flex-none font-semibold"
            onClick={onClearInvalid}
          >
            Clear invalid flag
          </Button>
        </div>
      )}

      <div className="mb-[18px] flex items-start gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-[1.35rem] font-semibold tracking-[-0.01em]">
              {run.run_id}
            </h1>
            <StatusBadge status={run.status} />
            <FavouriteStar type="run" id={run.run_id} label={run.run_id} />
          </div>
          <div className="mt-[3px] text-[0.8rem] text-ink-3">
            {run.description ?? "—"} · registered automatically when data arrived{" "}
            {formatArrival(run.first_data_at)} from{" "}
            <span className="font-mono text-[0.76rem]">{run.rig_id}</span>
          </div>
        </div>
        <div className="ml-auto flex flex-none gap-2">
          <RunActions
            run={run}
            isInvalid={isInvalid}
            onMarkInvalid={onMarkInvalid}
            onDelete={onDelete}
          />
        </div>
      </div>

      <MetadataPanel run={run} onEdit={onEdit} />
      {/* The definitions the run covers sit here and not in a tab: the tabs
          hold the run's DATA, this is its planning identity, and the Explore
          layout drops this header whole — metadata and definitions with it. */}
      <DefinitionsPanel run={run} />
      {/* Same run, same pick, in the Flight Test Station. */}
      <FtsPanel runId={run.run_id} signals={signals} />
    </>
  );
}
