"use client";

import { MultiSelectFilter, type FilterOption } from "@/components/shared/multi-select-filter";
import { SavedSearchButton } from "@/components/shared/saved-search-button";
import { SingleSelect } from "@/components/shared/single-select";
import {
  ToolbarDivider,
  ToolbarGroupLabel,
  ToolbarPanel,
  type Disclosure,
} from "@/components/shared/table-toolbar";
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

/**
 * The panel half of the two-tier toolbar. Four columns from the read
 * contract (`requirements-page/spec.md` §11.2) plus the widened set's
 * extensions — one control per filterable column that is not already a
 * quick view or the free-text search. §"Beyond §10" in the architecture doc
 * names which of these the read API does not (yet) define.
 */
export function RequirementsFiltersPanel({
  disclosure,
  table,
  facets,
  pathname,
}: {
  readonly disclosure: Disclosure;
  readonly table: UseTableStateResult;
  readonly facets: RequirementFacets | undefined;
  readonly pathname: string;
}) {
  const { state } = table;

  const presenceValue = (key: "has_verified_by" | "has_latest_run"): string =>
    state.single[key] ?? "any";
  const setPresence = (key: "has_verified_by" | "has_latest_run", value: string) =>
    table.setFilterValues(key, value === "any" ? [] : [value]);

  return (
    <ToolbarPanel disclosure={disclosure}>
      <ToolbarGroupLabel>Filter</ToolbarGroupLabel>
      <MultiSelectFilter
        label="Chapter"
        options={monoOptions(facets?.chapters)}
        selected={state.multi.chapter ?? []}
        onChange={(next) => table.setFilterValues("chapter", next)}
      />
      <MultiSelectFilter
        label="Status"
        options={monoOptions(facets?.statuses)}
        selected={state.multi.status ?? []}
        onChange={(next) => table.setFilterValues("status", next)}
      />
      <MultiSelectFilter
        label="Verification"
        options={VERIFICATION_OPTIONS}
        selected={state.multi.state ?? []}
        onChange={(next) => table.setFilterValues("state", next)}
      />
      <MultiSelectFilter
        label="Method"
        options={monoOptions(facets?.methods)}
        selected={state.multi.method ?? []}
        onChange={(next) => table.setFilterValues("method", next)}
      />
      <MultiSelectFilter
        label="EARS pattern"
        options={EARS_OPTIONS}
        selected={state.multi.ears_pattern ?? []}
        onChange={(next) => table.setFilterValues("ears_pattern", next)}
      />
      <MultiSelectFilter
        label="System state"
        options={monoOptions(facets?.system_states)}
        selected={state.multi.system_state ?? []}
        onChange={(next) => table.setFilterValues("system_state", next)}
      />
      <MultiSelectFilter
        label="Measurand"
        options={monoOptions(facets?.measurands)}
        selected={state.multi.measurand ?? []}
        onChange={(next) => table.setFilterValues("measurand", next)}
      />
      <MultiSelectFilter
        label="Source"
        options={monoOptions(facets?.sources)}
        selected={state.multi.source ?? []}
        onChange={(next) => table.setFilterValues("source", next)}
      />
      <ContainsFilterInput
        label="Revision"
        value={state.single.revision ?? ""}
        onApply={(value) => table.setFilterValues("revision", value.length > 0 ? [value] : [])}
        placeholder="0.1"
      />
      <ContainsFilterInput
        label="Related to"
        value={state.single.related_req ?? ""}
        onApply={(value) => table.setFilterValues("related_req", value.length > 0 ? [value] : [])}
        placeholder="req id"
      />
      <SingleSelect
        label="Verified by"
        value={presenceValue("has_verified_by")}
        onChange={(value) => setPresence("has_verified_by", value)}
        options={PRESENCE_OPTIONS}
      />
      <SingleSelect
        label="Latest run"
        value={presenceValue("has_latest_run")}
        onChange={(value) => setPresence("has_latest_run", value)}
        options={PRESENCE_OPTIONS}
      />

      <ToolbarDivider />

      <div className="ml-auto">
        <SavedSearchButton scope="requirements" pathname={pathname} query={table.buildQuery(state)} />
      </div>
    </ToolbarPanel>
  );
}
