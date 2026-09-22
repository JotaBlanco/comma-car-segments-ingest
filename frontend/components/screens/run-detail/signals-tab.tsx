"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableScrollArea } from "@/components/shared/panel";
import { LoadingRows } from "@/components/shared/loading-rows";
import { ActiveFilterPills, type FilterPill } from "@/components/shared/active-filter-pills";
import { MultiSelectFilter, type FilterOption } from "@/components/shared/multi-select-filter";
import { QuickViewSegment } from "@/components/shared/quick-view-segment";
import { SourceBadge } from "@/components/shared/source-badge";
import { ToneBadge } from "@/components/shared/status-badge";
import { TableEmptyState } from "@/components/shared/table-empty-state";
import { TablePager } from "@/components/shared/table-pager";
import { TableSearchInput } from "@/components/shared/table-search-input";
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "@/components/ui/combobox";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStat } from "@/components/screens/files/format";
import { formatInt, formatRate } from "@/lib/format";
import { useActor, usePatchSignal, useRunSignals, useSignalFacets } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import { MAX_QUIXLAB_SIGNALS } from "@/lib/quixlab";
import type { FileSignal } from "@/types";

/* The tab reads the actor once and hands it to every row. `useActor` starts a
   Portal handshake, and a run carries up to 500 rows, so one call per row
   would start 500 handshakes. */
function UnitCell({
  signal,
  runId,
  actor,
  units,
}: {
  signal: FileSignal;
  runId: string;
  actor: string | null;
  units: readonly string[];
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  // Enter must pick a HIGHLIGHTED suggestion (Base UI's turf) but save when
  // nothing is highlighted — a typed free-text unit commits on first Enter
  // even while the popup is open. Escape always cancels the whole edit.
  const [popupOpen, setPopupOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);
  const patchSignal = usePatchSignal(signal.name, actor);

  /* GET /test-runs/{run_id}/signals already applies the precedence rule, so a
     manual unit arrives on the row. The tab reads the row and overlays nothing. */
  const unit = signal.unit;
  const unitSource = signal.unit_source;

  const startEdit = () => {
    setValue(unit ?? "");
    setEditing(true);
  };

  const save = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === unit) {
      setEditing(false);
      return;
    }
    if (actor === null) {
      // The pencil is disabled without an identity, so this catches a race
      // with the profile query only.
      toast.error(NO_ACTOR_MESSAGE);
      setEditing(false);
      return;
    }
    patchSignal.mutate(
      { unit: trimmed, context_run_id: runId },
      {
        onSuccess: () => {
          toast(`Unit for ${signal.name} set to ${trimmed} — journalled as manual`);
          setEditing(false);
        },
        onError: () => {
          toast.error(`Could not save unit for ${signal.name}`);
        },
      }
    );
  };

  if (editing) {
    /* The catalog suggests, it never restricts (FR-DM-079a): any typed unit
       stays legal, so this is the free-text Autocomplete variant. */
    return (
      <Autocomplete
        items={units}
        value={value}
        onValueChange={(next) => setValue(next)}
        open={popupOpen}
        onOpenChange={setPopupOpen}
        onItemHighlighted={(item) => setHighlighted(item)}
      >
        <AutocompleteInput
          autoFocus
          disabled={patchSignal.isPending}
          aria-label={`Unit for ${signal.name}`}
          placeholder="e.g. %"
          className="h-6 w-24 rounded-sm px-1.5 font-mono text-[0.72rem]"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              /* A highlighted suggestion belongs to Base UI — Enter accepts
                 it. Otherwise Enter saves the typed text, popup or not. */
              if (popupOpen && highlighted !== undefined) return;
              event.preventDefault();
              save();
            }
            if (event.key === "Escape") {
              /* Escape cancels the whole edit — the inline-cell semantic.
                 The popup unmounts with the input. */
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
            }
          }}
          onBlur={() => {
            /* Save-on-blur: clicking away must not silently discard a typed value.
               Escape still cancels explicitly. Disabling the input while the patch
               is pending also fires blur — ignore it to avoid a duplicate save. */
            if (patchSignal.isPending) return;
            save();
          }}
        />
        <AutocompleteContent className="w-40">
          <AutocompleteList>
            {(unit: string) => (
              <AutocompleteItem key={unit} value={unit} className="font-mono text-[0.72rem]">
                {unit}
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompleteContent>
      </Autocomplete>
    );
  }

  const editButton = (
    <button
      type="button"
      // The disabled reason used to live in `title` only, which never reaches
      // a keyboard or screen-reader user — state it in the name (FR-DM-091).
      aria-label={
        actor === null
          ? `Edit unit for ${signal.name} — ${NO_ACTOR_MESSAGE}`
          : `Edit unit for ${signal.name}`
      }
      disabled={actor === null}
      title={actor === null ? NO_ACTOR_MESSAGE : undefined}
      className="rounded-sm text-ink-3 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
      onClick={startEdit}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
      </svg>
    </button>
  );

  if (unit === null) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <ToneBadge tone="amber" dot>
          missing
        </ToneBadge>
        {editButton}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[0.78rem]">{unit}</span>
      {unitSource !== null && <SourceBadge source={unitSource} />}
      {unitSource === "manual" && editButton}
    </span>
  );
}

// The API answers stats: null until the lake holds the samples. Show a dash, never a zero.
const NO_STAT = "—";

// One rounding rule for both signal tables. file-signals-table.tsx uses the
// same helper, so a value reads the same wherever the demo opens it.
const fmt = (value: number | null | undefined) =>
  value === undefined || value === null ? NO_STAT : formatStat(value);

// The real band registers 186 to 261 signals per run
// (plans/design/MF4-INGEST-INTEGRATION.md:269). 20 rows fit one screen, and
// the file signals table pages at 20 too, so both signal tables read alike.
// The API accepts the sizes in ALLOWED_PAGE_SIZES — 10, 20, 50, 100, 200 and
// 500 (api/api/models/common.py); the Rows select still offers 500, which
// holds the largest run whole, and the pager states the truth per page.
const DEFAULT_PAGE_SIZE = 20;

/** The Unit filter's entry for a row that carries no unit at all. The NUL
    prefix keeps the sentinel out of the space of real units — no unit string
    can carry NUL, so no real unit can ever collide with it. Written as the
    `\u0000` escape, never the raw byte: a raw NUL makes tools read the file
    as binary, and grep goes blind on it. */
const NO_UNIT = "\u0000no-unit";

/** Does the row carry numbers? The merge made a blank row normal. */
type ValueView = "all" | "measured" | "blank";

/**
 * The run's signals, and the pick a person sends to QuixLab.
 *
 * The pick is NOT held here. `RunDetailScreen` owns it, because the QuixLab
 * panel sits in the run header and this tab sits under it — the screen is the
 * only shared parent. This tab writes the list and the panel reads it, so one
 * list feeds both.
 */
export function SignalsTab({
  runId,
  signalCount,
  selected,
  onSelectedChange,
  onShownCountChange,
}: {
  runId: string;
  signalCount: number;
  /** The signal names picked for QuixLab. Empty means the whole run. */
  selected: readonly string[];
  onSelectedChange: (next: string[]) => void;
  /** How many rows the table shows, or null while every filter is off. */
  onShownCountChange?: (count: number | null) => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  /* Every filter runs on the rows the tab already holds. The run arrives in
     one page in the normal band, so a second call would buy nothing. The state
     is local: the run screen keeps `?tab=` in the URL, and a second writer on
     that URL would fight it. */
  const [search, setSearch] = useState("");
  const [unitPick, setUnitPick] = useState<readonly string[]>([]);
  const [ratePick, setRatePick] = useState<readonly string[]>([]);
  const [valueView, setValueView] = useState<ValueView>("all");
  const signalsQuery = useRunSignals(runId, { page, page_size: pageSize });
  const actor = useActor();
  /* One facets call feeds every row's unit autocomplete — the whole
     catalog's units, not the page's (FR-DM-079a). */
  const units = useSignalFacets().data?.units ?? [];

  /* Memoised: three option/row `useMemo`s below depend on it, and a fresh
     `[]` on every render would defeat all three. */
  const items = useMemo(() => signalsQuery.data?.items ?? [], [signalsQuery.data]);
  const total = signalsQuery.data?.total ?? 0;
  const totalPages = signalsQuery.data?.total_pages ?? 0;
  const needle = search.trim().toLowerCase();
  const filtered =
    needle.length > 0 || unitPick.length > 0 || ratePick.length > 0 || valueView !== "all";

  /* Every option comes from this run's own rows. A unit no signal of this run
     carries never reaches the popover, so no option can match nothing. */
  const unitOptions: readonly FilterOption[] = useMemo(() => {
    const named = Array.from(
      new Set(items.filter((signal) => signal.unit !== null).map((signal) => signal.unit as string))
    ).sort();
    const options: FilterOption[] = named.map((unit) => ({
      value: unit,
      label: <span className="font-mono text-[0.78rem]">{unit}</span>,
    }));
    if (items.some((signal) => signal.unit === null)) {
      /* A plain string, not the `missing` badge: `MultiSelectFilter` names an
         option checkbox by its value when the label is a node, and the value
         here is a sentinel no person should ever hear read out. */
      options.push({ value: NO_UNIT, label: "No unit" });
    }
    return options;
  }, [items]);

  const measuredCount = items.filter((signal) => signal.stats !== null).length;

  const rateOptions: readonly FilterOption[] = useMemo(
    () =>
      Array.from(new Set(items.map((signal) => signal.rate_hz)))
        .sort((a, b) => a - b)
        .map((hz) => ({
          /* The value stays the raw number, because that is what the filter
             matches against. Only the label rounds — otherwise the dropdown
             offers `50.00083362510212 Hz` while the column beside it reads
             `50 Hz`, and the two read as different rates. */
          value: String(hz),
          label: <span className="font-mono text-[0.78rem]">{formatRate(hz)} Hz</span>,
        })),
    [items]
  );

  /* `rows` is what a person sees. Every count below reads `rows`, never
     `items`, so no number on this tab can state more than the table shows. */
  const rows = useMemo(
    () =>
      items.filter((signal) => {
        if (needle.length > 0 && !signal.name.toLowerCase().includes(needle)) return false;
        if (unitPick.length > 0 && !unitPick.includes(signal.unit ?? NO_UNIT)) return false;
        if (ratePick.length > 0 && !ratePick.includes(String(signal.rate_hz))) return false;
        if (valueView !== "all" && (valueView === "measured") !== (signal.stats !== null)) return false;
        return true;
      }),
    [items, needle, unitPick, ratePick, valueView]
  );

  /* The tab strip prints the count too, and it sits in the parent screen. Hand
     the shown count up while a filter narrows the table, and null once every
     filter is off, so the strip falls back to the run's own signal count. */
  const shown = filtered ? rows.length : null;
  useEffect(() => {
    onShownCountChange?.(shown);
    return () => onShownCountChange?.(null);
  }, [shown, onShownCountChange]);
  /* Why this run carries blank numbers, or null when every signal carries
     numbers. The API reads the registry alone for this list, so the reason
     is always a measurement, never a configuration and never an outage. The
     footer says which of the three cases a person is looking at. */
  const statsUnavailable = signalsQuery.data?.stats_unavailable ?? null;

  /* The pick, read as a set once per render. A run carries up to 261 rows and
     every row asks "am I picked?", so a `find` per row would scan the list
     261 times. */
  const pickedSet = new Set(selected);
  const pagePicked = rows.filter((signal) => pickedSet.has(signal.name)).length;
  const wholePage = rows.length > 0 && pagePicked === rows.length;
  const partPage = pagePicked > 0 && !wholePage;
  const tooMany = selected.length > MAX_QUIXLAB_SIGNALS;
  /* A picked row the search then hides stays picked, because a search is a
     view and a pick is not. QuixLab therefore still opens it, so the caption
     below says the number out loud rather than let it travel unseen. */
  const hiddenPicked = items.filter((signal) => pickedSet.has(signal.name)).length - pagePicked;

  const clearFilters = () => {
    setSearch("");
    setUnitPick([]);
    setRatePick([]);
    setValueView("all");
    setPage(1);
  };

  /* One pill per applied value, the same shape the Signals screen uses. Each
     pill removes its own value, so every filter stays visible and removable. */
  const pills: readonly FilterPill[] = [
    ...unitPick.map((value) => ({
      id: `unit:${value}`,
      group: "Unit",
      label: value === NO_UNIT ? "missing" : value,
      onRemove: () => {
        setUnitPick(unitPick.filter((picked) => picked !== value));
        setPage(1);
      },
    })),
    ...ratePick.map((value) => ({
      id: `rate:${value}`,
      group: "Rate",
      label: `${value} Hz`,
      onRemove: () => {
        setRatePick(ratePick.filter((picked) => picked !== value));
        setPage(1);
      },
    })),
    ...(valueView === "all"
      ? []
      : [
          {
            id: "values",
            group: "Values",
            label: valueView === "measured" ? "Measured" : "Blank",
            onRemove: () => {
              setValueView("all");
              setPage(1);
            },
          },
        ]),
    ...(needle.length === 0
      ? []
      : [
          {
            id: "q",
            group: "Search",
            label: `“${search.trim()}”`,
            onRemove: () => {
              setSearch("");
              setPage(1);
            },
          },
        ]),
  ];

  const toggle = (name: string) => {
    if (pickedSet.has(name)) onSelectedChange(selected.filter((picked) => picked !== name));
    else onSelectedChange([...selected, name]);
  };

  /* The header box covers THIS PAGE, and nothing more. A page holds at most
     200 rows while a run holds up to 261, so "every row here" is not "the
     whole run" — the line under the table says which one a person got. */
  const togglePage = () => {
    const names = rows.map((signal) => signal.name);
    if (wholePage) {
      const onPage = new Set(names);
      onSelectedChange(selected.filter((picked) => !onPage.has(picked)));
      return;
    }
    onSelectedChange([...selected, ...names.filter((name) => !pickedSet.has(name))]);
  };

  return (
    <>
      <div className="border-b border-line-2 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <QuickViewSegment
            views={[
              { id: "all", label: "All", count: items.length },
              { id: "measured", label: "Measured", count: measuredCount },
              { id: "blank", label: "Blank", count: items.length - measuredCount },
            ]}
            activeId={valueView}
            onSelect={(id) => {
              setValueView(id as ValueView);
              setPage(1);
            }}
            aria-label="Signal value views"
          />
          <TableSearchInput
            value={search}
            onDebouncedChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Filter signals by name…"
          />
          <div className="flex-1" />
          <MultiSelectFilter
            label="Unit"
            options={unitOptions}
            note="Units of this run."
            selected={unitPick}
            onChange={(next) => {
              setUnitPick(next);
              setPage(1);
            }}
          />
          <MultiSelectFilter
            label="Rate"
            options={rateOptions}
            note="Rates of this run."
            selected={ratePick}
            onChange={(next) => {
              setRatePick(next);
              setPage(1);
            }}
          />
        </div>
        <ActiveFilterPills pills={pills} onClearAll={clearFilters} className="mt-2 mb-0" />
      </div>
      <div
        role="group"
        aria-label="Signals picked for QuixLab"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-2 px-4 py-2.5 text-[0.76rem] text-ink-3"
      >
        {selected.length === 0 ? (
          <span>
            No signal picked. QuixLab opens the whole run. Tick single rows to
            send only those signals.
          </span>
        ) : (
          <>
            <span className="font-semibold text-ink-2">
              {formatInt(selected.length)}{" "}
              {selected.length === 1 ? "signal" : "signals"} picked for QuixLab.
            </span>
            <button
              type="button"
              onClick={() => onSelectedChange([])}
              className="rounded-sm font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Clear
            </button>
          </>
        )}
        {/* One page does not always hold a whole run. Say so, rather than let
            a header box read as "the whole run is picked". */}
        {totalPages > 1 && (
          <span>
            This page holds {formatInt(items.length)} of {formatInt(total)} signals.
            The box in the header picks this page only. The filters above cover
            this page only.
          </span>
        )}
        {hiddenPicked > 0 && (
          <span>
            {formatInt(hiddenPicked)} of them{" "}
            {hiddenPicked === 1 ? "is" : "are"} hidden by the filters, and stay
            picked. QuixLab opens every picked signal.
          </span>
        )}
        {tooMany && (
          <span role="alert" className="font-semibold text-destructive">
            QuixLab accepts at most {formatInt(MAX_QUIXLAB_SIGNALS)} signals. Clear
            some picks, or the frame opens the whole run instead.
          </span>
        )}
      </div>
      {/* The tab sits in a page that scrolls, so the sticky opt-in needs its
          own bounded scroll region — `position: sticky` does nothing without
          one. The filter bar above and the pager below stay OUTSIDE it, so
          both stay reachable without scrolling the rows. */}
      <TableScrollArea className="max-h-[max(20rem,70dvh)]">
      <Table aria-label="Signals of this run">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <Checkbox
                checked={wholePage}
                indeterminate={partPage}
                disabled={rows.length === 0}
                onCheckedChange={togglePage}
                aria-label={
                  filtered ? "Select every signal shown" : "Select every signal on this page"
                }
              />
            </TableHead>
            <TableHead>Signal</TableHead>
            <TableHead>Unit</TableHead>
            <TableHead className="text-right">Rate</TableHead>
            <TableHead className="text-right">Min</TableHead>
            <TableHead className="text-right">Max</TableHead>
            <TableHead className="text-right">Mean</TableHead>
            <TableHead className="text-right">σ</TableHead>
            <TableHead className="text-right">RMS</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {signalsQuery.isPending && <LoadingRows rows={6} cols={9} />}
          {signalsQuery.isError && (
            <TableRow>
              <TableCell colSpan={9} className="p-0!">
                <ErrorState
                  message="Could not load signals for this run."
                  onRetry={() => void signalsQuery.refetch()}
                />
              </TableCell>
            </TableRow>
          )}
          {rows.map((signal) => (
            <TableRow key={signal.name} data-picked={pickedSet.has(signal.name) || undefined}>
              <TableCell>
                <Checkbox
                  checked={pickedSet.has(signal.name)}
                  onCheckedChange={() => toggle(signal.name)}
                  aria-label={`Select ${signal.name}`}
                />
              </TableCell>
              <TableCell>
                <span className="font-mono text-[0.78rem]">{signal.name}</span>
              </TableCell>
              <TableCell>
                <UnitCell signal={signal} runId={runId} actor={actor} units={units} />
              </TableCell>
              {/* Display only. The Rate filter above compares the RAW
                  rate_hz, so the rounding must never reach it. */}
              <TableCell className="text-right">{formatRate(signal.rate_hz)} Hz</TableCell>
              <TableCell className="text-right">{fmt(signal.stats?.min)}</TableCell>
              <TableCell className="text-right">{fmt(signal.stats?.max)}</TableCell>
              <TableCell className="text-right">{fmt(signal.stats?.mean)}</TableCell>
              {/* Same rounding rule as min/max/mean — σ used to keep two
                  decimals on its own, so one row printed "6.2" and "6.21"
                  side by side. */}
              <TableCell className="text-right">{fmt(signal.stats?.std)}</TableCell>
              {/* RMS merges over the files of a run, so this column carries a
                  number for a multi-file run as soon as the pipeline states
                  one. The two percentiles do NOT merge, and the demo lands
                  two files per run, so no percentile column belongs on this
                  tab: it would print a dash on every row of every real run.
                  The signal detail reads the lake and prints them there. */}
              <TableCell className="text-right">{fmt(signal.stats?.rms)}</TableCell>
            </TableRow>
          ))}
          {signalsQuery.isSuccess && rows.length === 0 && filtered && (
            <TableEmptyState
              colSpan={9}
              onClearAll={clearFilters}
              message="No signal matches these filters."
            />
          )}
          {signalsQuery.isSuccess && items.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="p-0!">
                {signalCount > 0 ? (
                  <EmptyState
                    title="No statistics yet"
                    message={`The run registers ${formatInt(signalCount)} signals. No registered file of this run has reported them yet.`}
                  />
                ) : (
                  <EmptyState
                    title="No signals cataloged"
                    message="No file on this run has reported a signal yet."
                  />
                )}
              </TableCell>
            </TableRow>
          )}
          {signalsQuery.isSuccess && rows.length > 0 && (
            <TableRow>
              <TableCell colSpan={9} className="py-2.5 text-center text-[0.74rem] text-ink-3">
                {/* Say which is true. The numbers on this table are measured
                    by the ingestion pipeline, not by the lake, so the footer
                    names the pipeline. It also never claims a measurement
                    over a column of dashes: the API states how much of the
                    run it measured, and these three branches read it. */}
                {statsUnavailable?.reason === "not_measured" ? (
                  <>
                    Signals cataloged from the file header. No statistics
                    measured for this run yet.{" "}
                  </>
                ) : statsUnavailable?.reason === "partly_measured" ? (
                  <>
                    Statistics measured at ingestion — no file download. A
                    signal with no numbers was not measured.{" "}
                  </>
                ) : (
                  <>Statistics measured at ingestion — no file download.{" "}</>
                )}
                <Link href="/signals" className="font-semibold text-primary">
                  Open the signal catalog
                </Link>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </TableScrollArea>
      {signalsQuery.isSuccess && total > 0 && (
        /* A filter narrows the rows this page holds, and every filter change
           sends the table back to page 1. So while a filter is on, the pager
           states the shown count over one page — never a server total that no
           longer matches the table. */
        <TablePager
          page={page}
          pageSize={pageSize}
          total={filtered ? rows.length : total}
          totalPages={filtered ? 1 : totalPages}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      )}
    </>
  );
}
