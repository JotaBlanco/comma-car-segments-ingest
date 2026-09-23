import type { FilterPill } from "@/components/shared/active-filter-pills";
import type { UseTableStateResult } from "@/lib/table-state";
import type { DefinitionStatus } from "@/types";
import { DEFINITION_STATUS_LABEL } from "./definitions-table-config";

/** Every active filter pill, named whether the filters overlay is open or
    shut — a shut overlay hides controls, never state. */
export function buildDefinitionPills(table: UseTableStateResult): readonly FilterPill[] {
  const { state } = table;
  const pills: FilterPill[] = [];

  const multiGroup = (key: string, group: string, label?: (value: string) => string) => {
    for (const value of state.multi[key] ?? []) {
      pills.push({
        id: `${key}:${value}`,
        group,
        label: label ? label(value) : value,
        onRemove: () => table.toggleFilterValue(key, value),
      });
    }
  };

  multiGroup("work_order", "Work order");
  multiGroup(
    "status",
    "Status",
    (value) => DEFINITION_STATUS_LABEL[value as DefinitionStatus] ?? value,
  );
  multiGroup("requirement", "Requirement");

  if (state.single.orphaned !== undefined) {
    pills.push({
      id: "orphaned",
      group: "Link",
      label: state.single.orphaned === "true" ? "Orphaned" : "Linked",
      onRemove: () => table.setFilterValues("orphaned", []),
    });
  }
  if (state.q.length > 0) {
    pills.push({
      id: "q",
      group: "Search",
      label: `"${state.q}"`,
      onRemove: () => table.setQ(""),
    });
  }

  return pills;
}
