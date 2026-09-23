"use client";

import { useState } from "react";
import { MultiSelectFilter, type FilterOption } from "@/components/shared/multi-select-filter";
import { SavedSearchButton } from "@/components/shared/saved-search-button";
import { SingleSelect } from "@/components/shared/single-select";
import { FiltersTriggerContent, toolbarTriggerClass } from "@/components/shared/table-toolbar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { UseTableStateResult } from "@/lib/table-state";
import { EARS_PATTERNS, type RequirementFacets } from "@/types";
import { ContainsFilterInput } from "./contains-filter-input";
import { VerificationChip } from "./verification-chip";
import { PRESENCE_OPTIONS, VERIFICATION_STATE_LABEL } from "./requirements-table-config";

const monoOptions = (values: readonly string[] | undefined): FilterOption[] =>
  (values ?? []).map((value) => ({
    value,
    label: <span className="font-mono text-[0.78rem]">{value}</span>,
  }));

const VERIFICATION_OPTIONS: readonly FilterOption[] = (
  Object.keys(VERIFICATION_STATE_LABEL) as (keyof typeof VERIFICATION_STATE_LABEL)[]
).map((state) => ({ value: state, label: <VerificationChip state={state} /> }));

const EARS_OPTIONS: readonly FilterOption[] = EARS_PATTERNS.map((pattern) => ({
  value: pattern,
  label: pattern,
}));

/** Every control fills its grid cell, so twelve of them read as a block. */
const CELL = "w-full justify-between";

/**
 * The twelve filters of the requirements grid, in an overlay hung off the
 * Filters button — one control per filterable column that is not already a
 * quick view or the free-text search (`requirements-page/spec.md` §11.2 plus
 * the widened set; "Beyond §10" in the architecture doc names which of these
 * the read API does not define).
 *
 * An overlay and not the inline `ToolbarPanel` the other screens use: twelve
 * controls wrap to two rows there, and both rows come off the table's height
 * on a page whose whole job is reading rows. The pills under the toolbar name
 * what is applied while this is shut, and the count rides on the trigger.
 *
 * Every control writes through `table`, so the URL contract is the same one
 * the inline panel had.
 */
export function RequirementsFiltersPopover({
  table,
  facets,
  pathname,
  activeCount,
}: {
  readonly table: UseTableStateResult;
  readonly facets: RequirementFacets | undefined;
  readonly pathname: string;
  readonly activeCount: number;
}) {
  const [open, setOpen] = useState(false);
  const { state } = table;

  const presenceValue = (key: "has_verified_by" | "has_latest_run"): string =>
    state.single[key] ?? "any";
  const setPresence = (key: "has_verified_by" | "has_latest_run", value: string) =>
    table.setFilterValues(key, value === "any" ? [] : [value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-haspopup="dialog"
        aria-expanded={open}
        className={toolbarTriggerClass(open)}
      >
        <FiltersTriggerContent open={open} activeCount={activeCount} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        aria-label="Requirement filters"
        className="w-[min(46rem,calc(100vw-3rem))] gap-0 p-3"
      >
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
          <MultiSelectFilter
            label="Chapter"
            className={CELL}
            options={monoOptions(facets?.chapters)}
            selected={state.multi.chapter ?? []}
            onChange={(next) => table.setFilterValues("chapter", next)}
          />
          <MultiSelectFilter
            label="Status"
            className={CELL}
            options={monoOptions(facets?.statuses)}
            selected={state.multi.status ?? []}
            onChange={(next) => table.setFilterValues("status", next)}
          />
          <MultiSelectFilter
            label="Verification"
            className={CELL}
            options={VERIFICATION_OPTIONS}
            selected={state.multi.state ?? []}
            onChange={(next) => table.setFilterValues("state", next)}
          />
          <MultiSelectFilter
            label="Method"
            className={CELL}
            options={monoOptions(facets?.methods)}
            selected={state.multi.method ?? []}
            onChange={(next) => table.setFilterValues("method", next)}
          />
          <MultiSelectFilter
            label="EARS pattern"
            className={CELL}
            options={EARS_OPTIONS}
            selected={state.multi.ears_pattern ?? []}
            onChange={(next) => table.setFilterValues("ears_pattern", next)}
          />
          <MultiSelectFilter
            label="System state"
            className={CELL}
            options={monoOptions(facets?.system_states)}
            selected={state.multi.system_state ?? []}
            onChange={(next) => table.setFilterValues("system_state", next)}
          />
          <MultiSelectFilter
            label="Measurand"
            className={CELL}
            options={monoOptions(facets?.measurands)}
            selected={state.multi.measurand ?? []}
            onChange={(next) => table.setFilterValues("measurand", next)}
          />
          <MultiSelectFilter
            label="Source"
            className={CELL}
            options={monoOptions(facets?.sources)}
            selected={state.multi.source ?? []}
            onChange={(next) => table.setFilterValues("source", next)}
          />
          <SingleSelect
            label="Verified by"
            className="w-full"
            triggerClassName="min-w-0 flex-1 justify-between"
            value={presenceValue("has_verified_by")}
            onChange={(value) => setPresence("has_verified_by", value)}
            options={PRESENCE_OPTIONS}
          />
          <SingleSelect
            label="Latest run"
            className="w-full"
            triggerClassName="min-w-0 flex-1 justify-between"
            value={presenceValue("has_latest_run")}
            onChange={(value) => setPresence("has_latest_run", value)}
            options={PRESENCE_OPTIONS}
          />
          <ContainsFilterInput
            label="Revision"
            inputClassName="w-full"
            value={state.single.revision ?? ""}
            onApply={(value) => table.setFilterValues("revision", value.length > 0 ? [value] : [])}
            placeholder="0.1"
          />
          <ContainsFilterInput
            label="Related to"
            inputClassName="w-full"
            value={state.single.related_req ?? ""}
            onApply={(value) =>
              table.setFilterValues("related_req", value.length > 0 ? [value] : [])
            }
            placeholder="req id"
          />
        </div>

        <div className="mt-3 flex items-center justify-end border-t border-line-2 pt-2.5">
          <SavedSearchButton
            scope="requirements"
            pathname={pathname}
            query={table.buildQuery(state)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
