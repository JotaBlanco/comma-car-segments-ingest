import type { FilterPill } from "@/components/shared/active-filter-pills";
import type { UseTableStateResult } from "@/lib/table-state";
import { VERIFICATION_STATE_LABEL } from "./requirements-table-config";

/** Every active filter pill, named whether the filter panel is open or shut
    (requirements-page spec §6, "Active filters always named"). */
export function buildRequirementPills(table: UseTableStateResult): readonly FilterPill[] {
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

  multiGroup("chapter", "Chapter");
  multiGroup("status", "Status");
  multiGroup(
    "state",
    "Verification",
    (value) => VERIFICATION_STATE_LABEL[value as keyof typeof VERIFICATION_STATE_LABEL] ?? value,
  );
  multiGroup("method", "Method");
  multiGroup("ears_pattern", "EARS pattern");
  multiGroup("system_state", "System state");
  multiGroup("measurand", "Measurand");
  multiGroup("source", "Source");

  if (state.single.revision !== undefined) {
    pills.push({
      id: "revision",
      group: "Revision",
      label: state.single.revision,
      onRemove: () => table.setFilterValues("revision", []),
    });
  }
  if (state.single.related_req !== undefined) {
    pills.push({
      id: "related_req",
      group: "Related to",
      label: state.single.related_req,
      onRemove: () => table.setFilterValues("related_req", []),
    });
  }
  if (state.single.has_verified_by !== undefined) {
    pills.push({
      id: "has_verified_by",
      group: "Verified by",
      label: state.single.has_verified_by === "true" ? "Has one" : "Has none",
      onRemove: () => table.setFilterValues("has_verified_by", []),
    });
  }
  if (state.single.has_latest_run !== undefined) {
    pills.push({
      id: "has_latest_run",
      group: "Latest run",
      label: state.single.has_latest_run === "true" ? "Has one" : "Has none",
      onRemove: () => table.setFilterValues("has_latest_run", []),
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
