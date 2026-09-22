"use client";

/**
 * FR-DM-108 — the Group-by control and the grouped answer for the runs screen.
 *
 * Both live here, and not in `runs-screen.tsx`, so the runs table keeps its
 * own file region. The screen adds the control to its toolbar and swaps the
 * panel; nothing inside the table changes.
 *
 * The grouped answer comes from `GET /test-runs/groups` (contract §2c). It is
 * a second route, never a field on the list, so the list keeps the shape the
 * contract pins. It takes the SAME filters object the list takes, so the
 * counts always describe the rows the flat table would show.
 */

import { ChevronDown } from "lucide-react";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingRows } from "@/components/shared/loading-rows";
import { Panel, TableScrollArea } from "@/components/shared/panel";
import { TablePager } from "@/components/shared/table-pager";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRunGroups } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { CUSTOM_GROUP_PREFIX } from "@/types";
import type { RunGroupBy, RunGroupByField, RunListFilters } from "@/types";

/* The workbook names five fields: project, test cell, vehicle, rig and bench.
   No run document holds a `vehicle` or a `bench` field, so the control offers
   the three that exist rather than two options that answer nothing.
   The labels are American English display text; the values are the wire
   names of contract §2c. */
export const RUN_GROUP_OPTIONS: readonly { value: RunGroupByField; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "test_cell", label: "Test cell" },
  { value: "rig", label: "Rig" },
];

const OFF = "";

/** The property key a `custom:` value names, or null for a fixed field. */
export function customGroupKey(value: string | undefined): string | null {
  if (value === undefined || !value.startsWith(CUSTOM_GROUP_PREFIX)) return null;
  return value.slice(CUSTOM_GROUP_PREFIX.length);
}

/** What the toolbar pill and the table header call this criterion. */
export function runGroupLabel(value: RunGroupBy): string {
  return (
    customGroupKey(value) ??
    RUN_GROUP_OPTIONS.find((option) => option.value === value)?.label ??
    value
  );
}

export interface RunGroupBySelectProps {
  readonly value: RunGroupBy | undefined;
  readonly onChange: (value: RunGroupBy | undefined) => void;
  /**
   * The custom property keys the runs table holds, from
   * `GET /test-runs/facets`. They ride under their own group in the list, so a
   * person PICKS a criterion of their own and never types one (FR-DM-108).
   */
  readonly customKeys?: readonly string[];
}

/**
 * A native select wearing the toolbar's trigger clothes.
 *
 * The element stays a `<select>`: it is the same choice the pager's
 * rows-per-page control makes, and a native listbox brings its own keyboard,
 * its own mobile picker and its own accessible name for free. Only the paint
 * changes. It used to render its own label text beside stock browser chrome,
 * which made it the one control on the row that matched none of the others.
 *
 * `appearance-none` removes the browser arrow; the chevron below replaces it
 * and is `pointer-events-none` so every click still reaches the select. The
 * label rides inside the box, so the control reads as one object, the way
 * `MultiSelectFilter` does.
 */
export function RunGroupBySelect({
  value,
  onChange,
  customKeys = [],
}: RunGroupBySelectProps) {
  /* A URL can already name a key that the current table no longer holds. The
     option list then carries it too, so the control shows the criterion that
     is really on instead of falling back to "None". */
  const selectedKey = customGroupKey(value);
  const keys =
    selectedKey !== null && !customKeys.includes(selectedKey)
      ? [...customKeys, selectedKey].sort()
      : customKeys;

  return (
    <div className="relative inline-flex flex-none items-center">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-[11px] text-[0.76rem] font-semibold text-ink-3"
      >
        Group by
      </span>
      <select
        value={value ?? OFF}
        aria-label="Group by"
        onChange={(event) =>
          onChange(event.target.value === OFF ? undefined : (event.target.value as RunGroupBy))
        }
        className={cn(
          "cursor-pointer appearance-none rounded-md border border-border bg-surface py-[5px] pl-[70px] pr-[26px] text-[0.76rem] font-semibold text-ink-2 transition-colors",
          "hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        <option value={OFF}>None</option>
        {RUN_GROUP_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {keys.length > 0 && (
          <optgroup label="Custom property">
            {keys.map((key) => (
              <option key={key} value={`${CUSTOM_GROUP_PREFIX}${key}`}>
                {key}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-[9px] size-[12px] text-ink-3"
        strokeWidth={2.2}
      />
    </div>
  );
}

export interface RunGroupsPanelProps {
  readonly groupBy: RunGroupBy;
  /** The filters the flat list would send. Paging rides along with them. */
  readonly filters: RunListFilters;
  readonly onPageChange: (page: number) => void;
  readonly onPageSizeChange: (size: number) => void;
}

const COL_COUNT = 2;

export function RunGroupsPanel({
  groupBy,
  filters,
  onPageChange,
  onPageSizeChange,
}: RunGroupsPanelProps) {
  /* The sort of the flat list has no meaning over groups — the API fixes the
     group order at count descending — so it never reaches this call. */
  const { sort: _sort, order: _order, ...rest } = filters;
  const { data, isPending, isError, refetch } = useRunGroups({ ...rest, group_by: groupBy });
  const label = runGroupLabel(groupBy);

  return (
    <Panel className="flex min-h-0 flex-1 flex-col">
      <TableScrollArea>
        <Table aria-label={`Test runs grouped by ${label.toLowerCase()}`}>
          <TableHeader>
            <TableRow>
              <TableHead>{label}</TableHead>
              <TableHead className="text-right!">Runs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <LoadingRows rows={5} cols={COL_COUNT} />}
            {isError && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COL_COUNT} className="p-0!">
                  <ErrorState onRetry={() => void refetch()} />
                </TableCell>
              </TableRow>
            )}
            {data?.items.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={COL_COUNT}
                  className="px-4 py-7 text-center text-[0.78rem] text-ink-3"
                >
                  {customGroupKey(groupBy) === null
                    ? "No runs to group."
                    : "No run carries this property."}
                </TableCell>
              </TableRow>
            )}
            {data?.items.map((group) => (
              /* A null value is a real group: the runs that carry no value for
                 this field. Naming it keeps the counts adding up to the list
                 total, and those are the runs a person groups the table to
                 find. */
              <TableRow key={group.value ?? " none"}>
                <TableCell>
                  {group.value === null ? (
                    <span className="text-[0.78rem] text-ink-3">Not set</span>
                  ) : (
                    <span className="font-mono text-[0.78rem]">{group.value}</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-[0.78rem]">
                  {group.count}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScrollArea>
      {data !== undefined && (
        /* The pages page over GROUPS, not over runs — contract §2c. The
           screen's own page state drives it, so one page control serves
           whichever answer the screen shows. */
        <TablePager
          page={data.page}
          pageSize={data.page_size}
          total={data.total}
          totalPages={data.total_pages}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      )}
    </Panel>
  );
}
