"use client";

import { useId, useMemo } from "react";
import { ActiveFilterPills, type FilterPill } from "@/components/shared/active-filter-pills";
import { ErrorState } from "@/components/shared/error-state";
import { JournalKindFilter } from "@/components/shared/entity-history-panel";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { LoadingRows } from "@/components/shared/loading-rows";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, PanelHead, TableScrollArea } from "@/components/shared/panel";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { SingleSelect, type SingleSelectOption } from "@/components/shared/single-select";
import { SourceBadge } from "@/components/shared/source-badge";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { ToolbarDivider, ToolbarFiltersButton, useDisclosure } from "@/components/shared/table-toolbar";
import { VerifiedActorMark } from "@/components/shared/verified-actor-mark";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatArrival } from "@/lib/format";
import { journalEntityHref } from "@/lib/journal-href";
import { useJournal } from "@/lib/hooks";
import { useTableState, type TableStateConfig } from "@/lib/table-state";
import type {
  JournalEntityType,
  JournalEntry,
  JournalKind,
  JournalListFilters,
  SourceTag,
} from "@/types";
import { ExactFilterInput } from "./exact-filter-input";

/**
 * Audit — the journal across every entity (FR-DM-055, NFR-DM-049).
 *
 * The six entity screens each show one history. An auditor asks a question
 * that names no entity: who changed this field, and what did this person do
 * last week. This screen asks `GET /journal` and it answers both.
 *
 * The filters live in the URL through `useTableState`, the way the runs, the
 * files and the signals screens keep theirs, so a filtered audit view is a
 * link a person can paste and the back button walks the filter history.
 * Every `GET /journal` param is single-value, so every key here is a
 * single-value pass-through — no repeated params.
 *
 * The layout keeps two tiers. The always-on row carries the two one-click
 * scopes — the kind segment and the entity type — and the way into the rest.
 * The panel carries the precision filters: the three exact-match boxes and
 * the date window. The pills row under them names every applied filter, so a
 * shut panel hides controls, never state.
 */

const AUDIT_COLUMNS = 7;

/** What each entity type is called in the Type column and the Type filter. */
const TYPE_LABELS: Record<JournalEntry["entity_type"], string> = {
  run: "Test run",
  file: "File",
  signal: "Signal",
  work_order: "Work order",
  result: "Result",
  test_definition: "Definition",
  requirement: "Requirement",
  export: "Export",
};

/** Every entity type the route takes, in the label map's order. */
const ENTITY_TYPES = Object.keys(TYPE_LABELS) as readonly JournalEntityType[];

const KINDS: readonly JournalKind[] = ["change", "event", "note"];

/* The whole `Source` enum (`api/api/models/common.py`) — a closed wire list,
   the same six tags the signals screen offers. The route matches one exactly. */
const SOURCE_TAGS: readonly SourceTag[] = [
  "embedded",
  "manual",
  "api:planning",
  "api:config",
  "api:catalogue",
  "api:post-processing",
];

/** The "no filter" choice of the Type select. It clears the URL key. */
const ANY = "any";

const TYPE_OPTIONS: readonly SingleSelectOption[] = [
  { value: ANY, label: "Any type" },
  ...ENTITY_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] })),
];

/* The wire tag is the label, the same word the Source column badges show. */
const SOURCE_OPTIONS: readonly SingleSelectOption[] = [
  { value: ANY, label: "Any source" },
  ...SOURCE_TAGS.map((tag) => ({ value: tag, label: tag })),
];

const AUDIT_TABLE_CONFIG: TableStateConfig = {
  multiKeys: [],
  singleKeys: ["kind", "entity_type", "entity_id", "field", "actor", "source", "since", "until"],
  sortKeys: [],
  defaultSort: null,
  defaultPageSize: 50,
  pageSizeOptions: [10, 20, 50, 100, 200, 500],
  quickViews: [],
};

/* The applied skin of the filter pills, for the Type select's trigger. The
   multi-select filters turn accent when a value is on; the select follows. */
const APPLIED_TRIGGER = "border-primary bg-accent-soft text-primary";

/** A day, as the date input writes it. Anything else stays out of the query. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* The small caps over each panel group — the ToolbarGroupLabel skin, on a
   span that can carry the id a `role="group"` points its name at. */
const GROUP_CAPTION =
  "select-none text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-ink-3";

/** The URL is caller input. A value off the list filters nothing. */
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** One date bound, labelled and bound to a day. */
function DayFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex max-w-full items-center gap-1.5 text-[0.72rem] text-ink-3">
      <span className="flex-none">{label}</span>
      {/* h-7, like every control in the filter strip. */}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 min-w-0 rounded-md border border-line bg-surface px-2 text-[0.78rem] text-ink outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
      />
    </label>
  );
}

/** What one journal entry changed, in one cell. */
function ChangeCell({ entry }: { entry: JournalEntry }) {
  if (entry.kind === "change") {
    return (
      <span className="text-[0.78rem]">
        <span className="text-ink-3">{entry.old ?? "(empty)"}</span>
        <span aria-hidden className="px-1 text-ink-3">
          →
        </span>
        <span className="sr-only">changed to</span>
        {entry.new ?? "(empty)"}
      </span>
    );
  }
  if (entry.note !== null) return <span className="whitespace-normal">{entry.note}</span>;
  return <span className="text-ink-3">—</span>;
}

export function AuditScreen() {
  const table = useTableState(AUDIT_TABLE_CONFIG, "/audit");
  const { state } = table;

  /* The names of the panel groups, for `aria-labelledby`. */
  const exactCaptionId = useId();
  const exactHintId = useId();
  const periodCaptionId = useId();

  /* The URL is typed by anybody. The enum keys pass through a membership
     check, so a mistyped deep link reads as "no filter", never as a 422. */
  const kind = oneOf(state.single.kind, KINDS);
  const entityType = oneOf(state.single.entity_type, ENTITY_TYPES);
  const source = oneOf(state.single.source, SOURCE_TAGS);
  const entityId = state.single.entity_id ?? "";
  const field = state.single.field ?? "";
  const actor = state.single.actor ?? "";
  const sinceRaw = state.single.since ?? "";
  const untilRaw = state.single.until ?? "";
  const since = DAY.test(sinceRaw) ? sinceRaw : "";
  const until = DAY.test(untilRaw) ? untilRaw : "";

  /* The panel controls, counted. The kind segment and the Type select stay on
     the always-on row, so neither counts here — the count reports only what a
     shut panel hides, and it opens the panel on arrival from a deep link. */
  const activeFilterCount =
    (entityId === "" ? 0 : 1) +
    (field === "" ? 0 : 1) +
    (actor === "" ? 0 : 1) +
    (source === undefined ? 0 : 1) +
    (since === "" ? 0 : 1) +
    (until === "" ? 0 : 1);
  const disclosure = useDisclosure(activeFilterCount);

  /* A day names a whole day, and the API bounds a moment. The window opens at
     the first moment of `since` and it closes at the last moment of `until`,
     so a person who picks one day reads that whole day. */
  const filters: JournalListFilters = useMemo(
    () => ({
      ...(kind !== undefined ? { kind } : {}),
      ...(entityType !== undefined ? { entity_type: entityType } : {}),
      ...(entityId.length > 0 ? { entity_id: entityId } : {}),
      ...(field.length > 0 ? { field } : {}),
      ...(actor.length > 0 ? { actor } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(since.length > 0 ? { since: `${since}T00:00:00Z` } : {}),
      ...(until.length > 0 ? { until: `${until}T23:59:59Z` } : {}),
      page: state.page,
      page_size: state.pageSize,
    }),
    [kind, entityType, entityId, field, actor, source, since, until, state.page, state.pageSize],
  );

  const { data, isPending, isError, refetch } = useJournal(filters);
  const entries = data?.items;
  const showEmpty = !isPending && !isError && entries !== undefined && entries.length === 0;

  /* The exact-match boxes are where a half-typed value dead-ends. When one is
     on and nothing matches, the empty state states the rule, so an empty
     table reads as "wrong value", never as "the journal lost my entry". */
  const exactFilterOn = entityId.length > 0 || field.length > 0 || actor.length > 0;
  const emptyMessage = exactFilterOn
    ? "No entries match. The field, actor and id filters match the stored value exactly — “a.berg” never finds “a.bergstrom”. Check the full value, or clear the filters."
    : undefined;

  /** Set or clear one single-value URL key. */
  const setOne = (key: string, value: string) =>
    table.setFilterValues(key, value.length > 0 ? [value] : []);

  /* One pill per applied filter, so the state stays visible with the panel
     shut. The kind segment names its own state on the always-on row, so it
     draws no pill. */
  const pills: readonly FilterPill[] = useMemo(() => {
    const list: FilterPill[] = [];
    if (entityType !== undefined) {
      list.push({
        id: "entity_type",
        group: "Type",
        label: TYPE_LABELS[entityType],
        onRemove: () => table.setFilterValues("entity_type", []),
      });
    }
    if (entityId.length > 0) {
      list.push({
        id: "entity_id",
        group: "Id",
        label: entityId,
        onRemove: () => table.setFilterValues("entity_id", []),
      });
    }
    if (field.length > 0) {
      list.push({
        id: "field",
        group: "Field",
        label: field,
        onRemove: () => table.setFilterValues("field", []),
      });
    }
    if (actor.length > 0) {
      list.push({
        id: "actor",
        group: "Actor",
        label: actor,
        onRemove: () => table.setFilterValues("actor", []),
      });
    }
    if (source !== undefined) {
      list.push({
        id: "source",
        group: "Source",
        label: source,
        onRemove: () => table.setFilterValues("source", []),
      });
    }
    if (since.length > 0) {
      list.push({
        id: "since",
        group: "From",
        label: since,
        onRemove: () => table.setFilterValues("since", []),
      });
    }
    if (until.length > 0) {
      list.push({
        id: "until",
        group: "To",
        label: until,
        onRemove: () => table.setFilterValues("until", []),
      });
    }
    return list;
  }, [entityType, entityId, field, actor, source, since, until, table]);

  return (
    <FullHeightPage>
      <PageHeader
        title="Audit"
        sub="Every change, every event and every note the registry recorded, across every entity."
      />
      <Panel className="flex min-h-0 flex-1 flex-col">
        <PanelHead
          title="Journal"
          action={
            data !== undefined && (
              <span className="font-mono text-[0.68rem] text-ink-3">
                {data.total} {data.total === 1 ? "entry" : "entries"}
              </span>
            )
          }
        />
        {/* Tier one: the two one-click scopes. The kind and the type are both
            closed lists a reader narrows on nearly every visit, so they stay
            in reach. Everything a person must type sits in the panel. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line-2 px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <JournalKindFilter
              aria-label="Filter the audit journal by kind"
              kind={kind}
              onKindChange={(next) => setOne("kind", next ?? "")}
            />
            <ToolbarDivider />
            <SingleSelect
              label="Type"
              value={entityType ?? ANY}
              options={TYPE_OPTIONS}
              onChange={(next) => setOne("entity_type", next === ANY ? "" : next)}
              triggerClassName={entityType !== undefined ? APPLIED_TRIGGER : undefined}
            />
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <ToolbarFiltersButton disclosure={disclosure} />
          </div>
        </div>

        {/* The panel holds GROUP BLOCKS, never loose controls. Each block
            keeps its caption and its controls in one subtree, so a caption can
            never end a line while its fields start the next. The blocks sit in
            two rows up to 2xl and in one row past it — a fixed structure, so
            the house rule between groups (`ToolbarDivider`'s tokens: w-px,
            bg-line, mx-0.5) only ever draws where two groups truly share a
            line. Where the groups stack instead, the boundary turns into a
            horizontal hairline. */}
        {disclosure.open && (
          <div
            id={disclosure.id}
            className="flex flex-col gap-3 border-b border-line-2 bg-surface-2/40 px-4 py-3 2xl:flex-row 2xl:items-stretch 2xl:gap-x-3"
          >
            {/* The exact trio. The rule reads ONCE here, on the group — the
                inputs carry no tag. Each input keeps the rule in its own
                described-by hint for a screen reader. */}
            <div
              role="group"
              aria-labelledby={exactCaptionId}
              aria-describedby={exactHintId}
              className="min-w-0 max-w-full"
            >
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span id={exactCaptionId} className={GROUP_CAPTION}>
                  Exact match
                </span>
                <span id={exactHintId} className="min-w-0 text-[0.68rem] text-ink-3">
                  Whole value only — “a.berg” never finds “a.bergstrom”. Applies on Enter.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <ExactFilterInput
                  label="Field"
                  value={field}
                  onApply={(next) => setOne("field", next)}
                  placeholder="e.g. run.operator"
                />
                <ExactFilterInput
                  label="Actor"
                  value={actor}
                  onApply={(next) => setOne("actor", next)}
                  placeholder="e.g. a.bergstrom"
                />
                <ExactFilterInput
                  label="Entity id"
                  value={entityId}
                  onApply={(next) => setOne("entity_id", next)}
                  placeholder="e.g. TAS-88214"
                />
              </div>
            </div>

            {/* The house rule, when the exact block shares the line (2xl+). */}
            <span aria-hidden="true" className="mx-0.5 hidden w-px flex-none self-stretch bg-line 2xl:block" />

            {/* Below 2xl this row stacks under the exact block, so the group
                boundary above it draws as a horizontal hairline instead. */}
            <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-3 border-t border-line pt-3 2xl:border-t-0 2xl:pt-0">
              {/* One control, so the caption is the label. The select keeps
                  the real name "Source" for assistive tech through
                  `labelHidden`; the caption only draws it. */}
              <div className="min-w-0">
                <span aria-hidden="true" className={`${GROUP_CAPTION} mb-1.5 block`}>
                  Source
                </span>
                {/* `max-w-full` caps the nowrap trigger inside the panel at
                    extreme widths; its value text line-clamps on its own. */}
                <SingleSelect
                  label="Source"
                  labelHidden
                  value={source ?? ANY}
                  options={SOURCE_OPTIONS}
                  onChange={(next) => setOne("source", next === ANY ? "" : next)}
                  className="max-w-full min-w-0"
                  triggerClassName={
                    source !== undefined ? `max-w-full ${APPLIED_TRIGGER}` : "max-w-full"
                  }
                />
              </div>

              {/* The house rule again. It hides once the two groups stack,
                  because a rule between stacked rows points at nothing. */}
              <span aria-hidden="true" className="mx-0.5 hidden w-px flex-none self-stretch bg-line sm:block" />

              <div role="group" aria-labelledby={periodCaptionId} className="min-w-0 max-w-full">
                <span id={periodCaptionId} className={`${GROUP_CAPTION} mb-1.5 block`}>
                  Period
                </span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <DayFilter label="From" value={since} onChange={(day) => setOne("since", day)} />
                  <DayFilter label="To" value={until} onChange={(day) => setOne("until", day)} />
                </div>
              </div>
            </div>
          </div>
        )}

        <ActiveFilterPills
          pills={pills}
          onClearAll={() => table.clearAll()}
          className="mb-0 border-b border-line-2 px-4 py-2"
        />
        <TableScrollArea>
          <Table aria-label="Audit journal">
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Field</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && (
                <LoadingRows rows={6} cols={AUDIT_COLUMNS} label="Loading the audit journal" />
              )}
              {isError && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={AUDIT_COLUMNS} className="p-0!">
                    <ErrorState
                      message="Could not load the audit journal."
                      onRetry={() => void refetch()}
                    />
                  </TableCell>
                </TableRow>
              )}
              {showEmpty && (
                <TableEmptyState
                  colSpan={AUDIT_COLUMNS}
                  onClearAll={() => table.clearAll()}
                  message={emptyMessage}
                />
              )}
              {entries?.map((entry) => {
                const href = journalEntityHref(entry);
                const cells = (
                  <>
                    <TableCell>
                      <RowLinkLabel>
                        <span className="font-mono text-[0.78rem]">{entry.entity_id}</span>
                      </RowLinkLabel>
                    </TableCell>
                    <TableCell>{TYPE_LABELS[entry.entity_type]}</TableCell>
                    <TableCell className="font-mono text-[0.78rem]">
                      {entry.field ?? <span className="text-ink-3">—</span>}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <ChangeCell entry={entry} />
                    </TableCell>
                    <TableCell>
                      {entry.actor}
                      <VerifiedActorMark actorId={entry.actor_id} />
                    </TableCell>
                    <TableCell>
                      <SourceBadge source={entry.source} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatArrival(entry.at)}</TableCell>
                  </>
                );
                if (href === null) return <TableRow key={entry.id}>{cells}</TableRow>;
                return (
                  <RowLink key={entry.id} href={href}>
                    {cells}
                  </RowLink>
                );
              })}
            </TableBody>
          </Table>
        </TableScrollArea>
        {/* The numbers come from the response envelope, never from the
            request state — the files screen wires its pager the same way. */}
        {data !== undefined && (
          <TablePager
            page={data.page}
            pageSize={data.page_size}
            total={data.total}
            totalPages={data.total_pages}
            onPageChange={(page) => table.setPage(page)}
            onPageSizeChange={(size) => table.setPageSize(size)}
          />
        )}
      </Panel>
    </FullHeightPage>
  );
}
