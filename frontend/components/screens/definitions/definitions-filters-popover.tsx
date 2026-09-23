"use client";

import { useState } from "react";
import { MultiSelectFilter, type FilterOption } from "@/components/shared/multi-select-filter";
import { SingleSelect } from "@/components/shared/single-select";
import { FiltersTriggerContent, toolbarTriggerClass } from "@/components/shared/table-toolbar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { UseTableStateResult } from "@/lib/table-state";
import type { DefinitionStatus, TestDefinitionFacets } from "@/types";
import { DEFINITION_STATUS_LABEL, ORPHANED_OPTIONS } from "./definitions-table-config";

const monoOptions = (values: readonly string[] | undefined): FilterOption[] =>
  (values ?? []).map((value) => ({
    value,
    label: <span className="font-mono text-[0.78rem]">{value}</span>,
  }));

const statusOptions = (values: readonly string[] | undefined): FilterOption[] =>
  (values ?? []).map((value) => ({
    value,
    label: DEFINITION_STATUS_LABEL[value as DefinitionStatus] ?? value,
  }));

/** Every control fills its grid cell, so the four read as a block. */
const CELL = "w-full justify-between";

/**
 * The four filters of the test definitions grid, in an overlay hung off the
 * Filters button — one control per filter `GET /test-definitions` takes that
 * is not the free-text search in the toolbar.
 *
 * The three sets come from `/test-definitions/facets`, so each offers every
 * value the mirror holds and not only the values of the page on screen.
 *
 * An overlay and not the inline `ToolbarPanel`, for the reason the
 * requirements grid uses one: the controls come off the table's height on a
 * page whose whole job is reading rows. The pills under the toolbar name what
 * is applied while this is shut, and the count rides on the trigger.
 */
export function DefinitionsFiltersPopover({
  table,
  facets,
  activeCount,
}: {
  readonly table: UseTableStateResult;
  readonly facets: TestDefinitionFacets | undefined;
  readonly activeCount: number;
}) {
  const [open, setOpen] = useState(false);
  const { state } = table;

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
        aria-label="Test definition filters"
        className="w-[min(34rem,calc(100vw-3rem))] gap-0 p-3"
      >
        <div className="grid grid-cols-2 gap-2.5">
          <MultiSelectFilter
            label="Work order"
            className={CELL}
            options={monoOptions(facets?.work_orders)}
            emptyText="The mirror holds no work order."
            selected={state.multi.work_order ?? []}
            onChange={(next) => table.setFilterValues("work_order", next)}
          />
          <MultiSelectFilter
            label="Status"
            className={CELL}
            options={statusOptions(facets?.statuses)}
            emptyText="The mirror holds no definition."
            selected={state.multi.status ?? []}
            onChange={(next) => table.setFilterValues("status", next)}
          />
          <MultiSelectFilter
            label="Requirement"
            className={CELL}
            options={monoOptions(facets?.requirements)}
            emptyText="No definition covers a requirement."
            selected={state.multi.requirement ?? []}
            onChange={(next) => table.setFilterValues("requirement", next)}
          />
          <SingleSelect
            label="Link"
            className="w-full"
            triggerClassName="min-w-0 flex-1 justify-between"
            value={state.single.orphaned ?? "any"}
            onChange={(value) =>
              table.setFilterValues("orphaned", value === "any" ? [] : [value])
            }
            options={ORPHANED_OPTIONS}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
