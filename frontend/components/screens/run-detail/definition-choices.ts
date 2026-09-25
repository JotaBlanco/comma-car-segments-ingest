import { ApiError } from "@/lib/api/client";
import type {
  DefinitionStatus,
  RequirementRow,
  TestDefinitionListItem,
  WorkOrderListItem,
} from "@/types";

/**
 * What the definitions panel and its add dialog share: the rows the dialog
 * offers, and the words for a refusal from the two
 * `/test-runs/{run_id}/definitions` routes.
 *
 * Neither a project nor a feature is a field on a test definition. The
 * project comes from its work order, the only row that names one, and the
 * feature is the `system` of the requirements it verifies — read from both
 * projections of the verifies relation (`verified_by`, derived;
 * `covers_req_ids`, authored) the way
 * `components/screens/traceability/traceability-model.ts` reads it.
 */

/** The selector value that narrows nothing. */
export const ANY = "__any";
/** The selector value for rows whose project or feature resolves to nothing. */
export const NONE = "__none";

export interface DefinitionChoice {
  readonly tdId: string;
  readonly title: string;
  readonly status: DefinitionStatus;
  /** Null when the definition names no work order this registry mirrors. */
  readonly project: string | null;
  /** Every system its requirements name — two systems put it under both. */
  readonly features: readonly string[];
  readonly chapters: readonly string[];
  /** Already one of the run's `definition_ids`. */
  readonly present: boolean;
}

export interface DefinitionChoicesInput {
  readonly requirements: readonly RequirementRow[];
  readonly definitions: readonly TestDefinitionListItem[];
  readonly workOrders: readonly WorkOrderListItem[];
  readonly present: readonly string[];
}

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

function named(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function distinct(values: readonly (string | null)[]): string[] {
  const found = new Set<string>();
  for (const value of values) {
    if (value !== null) found.add(value);
  }
  return [...found].sort(byText);
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const held = map.get(key);
  if (held === undefined) map.set(key, new Set([value]));
  else held.add(value);
}

export function buildDefinitionChoices(input: DefinitionChoicesInput): DefinitionChoice[] {
  const { requirements, definitions, workOrders, present } = input;

  const projectByWorkOrder = new Map<string, string | null>(
    workOrders.map((row) => [row.wo_id, named(row.project)]),
  );
  const requirementById = new Map<string, RequirementRow>(
    requirements.map((row) => [row.req_id, row]),
  );
  const onRun = new Set(present);

  const reqIdsByDefinition = new Map<string, Set<string>>();
  for (const requirement of requirements) {
    for (const tdId of requirement.verified_by) addTo(reqIdsByDefinition, tdId, requirement.req_id);
  }
  for (const definition of definitions) {
    for (const reqId of definition.covers_req_ids ?? []) {
      if (requirementById.has(reqId)) addTo(reqIdsByDefinition, definition.td_id, reqId);
    }
  }

  const projectOf = (definition: TestDefinitionListItem): string | null => {
    if (definition.work_order_id === null) return null;
    return projectByWorkOrder.get(definition.work_order_id) ?? null;
  };

  return [...definitions]
    .sort((a, b) => byText(a.td_id, b.td_id))
    .map((definition) => {
      const covered = [...(reqIdsByDefinition.get(definition.td_id) ?? [])]
        .sort(byText)
        .map((reqId) => requirementById.get(reqId))
        .filter((row): row is RequirementRow => row !== undefined);
      return {
        tdId: definition.td_id,
        title: definition.title,
        status: definition.status,
        project: projectOf(definition),
        features: distinct(covered.map((row) => named(row.system))),
        chapters: distinct(covered.map((row) => named(row.chapter))),
        present: onRun.has(definition.td_id),
      };
    });
}

export function projectsOf(choices: readonly DefinitionChoice[]): string[] {
  return distinct(choices.map((choice) => choice.project));
}

export function featuresOf(choices: readonly DefinitionChoice[]): string[] {
  return distinct(choices.flatMap((choice) => [...choice.features]));
}

/** True when some row would be left out of both the named values. */
export function someUnresolved(
  choices: readonly DefinitionChoice[],
  facet: "project" | "feature",
): boolean {
  return choices.some((choice) =>
    facet === "project" ? choice.project === null : choice.features.length === 0,
  );
}

export function narrow(
  choices: readonly DefinitionChoice[],
  project: string,
  feature: string,
): DefinitionChoice[] {
  return choices.filter((choice) => {
    const projectFits =
      project === ANY
        ? true
        : project === NONE
          ? choice.project === null
          : choice.project === project;
    const featureFits =
      feature === ANY
        ? true
        : feature === NONE
          ? choice.features.length === 0
          : choice.features.includes(feature);
    return projectFits && featureFits;
  });
}

/** One sentence a person can act on, per refusal the two routes answer. */
const FAILURES: Record<string, string> = {
  run_not_found: "The registry holds no run under this id any more. Reload the screen.",
  unknown_definition:
    "The registry mirrors no test definition under that id. Run a planning sync, then try again.",
};

export function runDefinitionFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused it: ${error.detail}`;
  }
  return "The change never reached the registry. Check the connection and try again.";
}
