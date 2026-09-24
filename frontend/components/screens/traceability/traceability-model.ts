import type {
  RequirementRow,
  TestDefinitionListItem,
  TestRunListItem,
  WorkOrderListItem,
} from "@/types";

/**
 * The traceability tree, assembled in the browser from four registry lists.
 *
 * `project → system → {Requirements, Test definitions} → entity → the level
 * below it`. A requirement discloses the definitions that verify it and each
 * of those discloses the runs that carry it, so one definition shows up both
 * under its requirement and in the sibling group — the two groups answer two
 * different questions and the screen says so rather than dropping one.
 *
 * Neither a requirement nor a definition carries a project. It is resolved
 * through the definition's work order, the only row that names one.
 */

export type TreeKind = "project" | "system" | "group" | "requirement" | "definition" | "run";

interface NodeBase {
  /** Unique over the whole tree: an entity under two parents has two keys. */
  key: string;
  /** The muted word before the name on a folder row. */
  prefix: string | null;
  label: string;
  /** The title beside an id, or a run's description. */
  secondary: string | null;
  href: string | null;
  /** What this row would have disclosed, said in words because it has nothing. */
  gap: string | null;
  /** A muted line above the children, shown once the row opens. */
  hint: string | null;
  children: TreeNode[];
}

export type TreeNode =
  | (NodeBase & { kind: "project" | "system" | "group" })
  | (NodeBase & { kind: "requirement"; requirement: RequirementRow })
  | (NodeBase & { kind: "definition"; definition: TestDefinitionListItem })
  | (NodeBase & { kind: "run"; run: TestRunListItem });

export interface TraceabilityInput {
  requirements: readonly RequirementRow[];
  definitions: readonly TestDefinitionListItem[];
  runs: readonly TestRunListItem[];
  workOrders: readonly WorkOrderListItem[];
}

/**
 * The system a mirror that does not carry the field at all reads as. A row
 * that DOES carry it and names none is a different fact and groups under "No
 * system" — so this constant dies with the last mirror built before
 * `RequirementRow.system` shipped, and nothing else in this screen knows the
 * string.
 */
export const FALLBACK_SYSTEM = "BMS";

function systemOf(requirement: RequirementRow): string | null {
  const named = (requirement as RequirementRow & { system?: string | null }).system;
  if (named === undefined) return FALLBACK_SYSTEM;
  if (named === null || named.trim() === "") return null;
  return named;
}

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** Unnamed last: "No project" and "No system" close their level. */
function nullLast(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return byText(a, b);
}

const newestFirst = (a: TestRunListItem, b: TestRunListItem): number =>
  Date.parse(b.first_data_at) - Date.parse(a.first_data_at) || byText(a.run_id, b.run_id);

function definitionIdsOf(run: TestRunListItem): readonly string[] {
  if (run.definition_ids !== undefined) return run.definition_ids;
  return run.definition_id === null ? [] : [run.definition_id];
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const held = map.get(key);
  if (held === undefined) map.set(key, new Set([value]));
  else held.add(value);
}

function runNode(parentKey: string, run: TestRunListItem): TreeNode {
  return {
    kind: "run",
    key: `${parentKey}/n:${run.run_id}`,
    prefix: null,
    label: run.run_id,
    secondary: run.description,
    href: `/runs/${encodeURIComponent(run.run_id)}`,
    gap: null,
    hint: null,
    children: [],
    run,
  };
}

interface GroupSpec {
  key: string;
  label: string;
  href: string;
  children: TreeNode[];
  /** Read in place of the children when there are none. */
  gap: string;
  hint?: string;
}

function groupNode(spec: GroupSpec): TreeNode {
  return {
    kind: "group",
    key: spec.key,
    prefix: null,
    label: spec.label,
    secondary: null,
    href: spec.href,
    gap: spec.children.length === 0 ? spec.gap : null,
    hint: spec.hint ?? null,
    children: spec.children,
  };
}

interface Bucket {
  requirements: RequirementRow[];
  definitions: TestDefinitionListItem[];
}

export function buildTraceabilityTree(input: TraceabilityInput): TreeNode[] {
  const { requirements, definitions, runs, workOrders } = input;

  const reqById = new Map<string, RequirementRow>(
    requirements.map((row) => [row.req_id, row]),
  );
  const defById = new Map<string, TestDefinitionListItem>(
    definitions.map((row) => [row.td_id, row]),
  );
  const projectByWorkOrder = new Map<string, string>(
    workOrders.map((row) => [row.wo_id, row.project]),
  );

  const runsByDefinition = new Map<string, TestRunListItem[]>();
  const looseRuns: TestRunListItem[] = [];
  for (const run of runs) {
    const ids = definitionIdsOf(run);
    if (ids.length === 0) {
      looseRuns.push(run);
      continue;
    }
    for (const id of ids) {
      const held = runsByDefinition.get(id);
      if (held === undefined) runsByDefinition.set(id, [run]);
      else held.push(run);
    }
  }

  /* The verifies relation, read from both of its projections: the
     requirement's derived `verified_by` (SYS.2 BP5) and the definition's
     authored `covers_req_ids`. */
  const reqIdsByDefinition = new Map<string, Set<string>>();
  const defIdsByRequirement = new Map<string, Set<string>>();
  const link = (tdId: string, reqId: string): void => {
    addTo(reqIdsByDefinition, tdId, reqId);
    addTo(defIdsByRequirement, reqId, tdId);
  };
  for (const requirement of requirements) {
    for (const tdId of requirement.verified_by) link(tdId, requirement.req_id);
  }
  for (const definition of definitions) {
    for (const reqId of definition.covers_req_ids ?? []) {
      if (reqById.has(reqId)) link(definition.td_id, reqId);
    }
  }

  /* A definition has no system of its own: it inherits every system its
     requirements name, so one covering two systems stands under both. */
  const systemsOf = (definition: TestDefinitionListItem): (string | null)[] => {
    const found = new Set<string | null>();
    for (const reqId of reqIdsByDefinition.get(definition.td_id) ?? []) {
      const requirement = reqById.get(reqId);
      if (requirement !== undefined) found.add(systemOf(requirement));
    }
    return found.size === 0 ? [null] : [...found].sort(nullLast);
  };

  const projectOf = (definition: TestDefinitionListItem): string | null => {
    if (definition.work_order_id === null) return null;
    return projectByWorkOrder.get(definition.work_order_id) ?? null;
  };

  const projectsOf = (requirement: RequirementRow): (string | null)[] => {
    const found = new Set<string>();
    for (const tdId of defIdsByRequirement.get(requirement.req_id) ?? []) {
      const definition = defById.get(tdId);
      if (definition === undefined) continue;
      const project = projectOf(definition);
      if (project !== null) found.add(project);
    }
    return found.size === 0 ? [null] : [...found].sort(byText);
  };

  const buckets = new Map<string | null, Map<string | null, Bucket>>();
  const bucketFor = (project: string | null, system: string | null): Bucket => {
    let systems = buckets.get(project);
    if (systems === undefined) {
      systems = new Map<string | null, Bucket>();
      buckets.set(project, systems);
    }
    let bucket = systems.get(system);
    if (bucket === undefined) {
      bucket = { requirements: [], definitions: [] };
      systems.set(system, bucket);
    }
    return bucket;
  };

  for (const requirement of [...requirements].sort((a, b) => byText(a.req_id, b.req_id))) {
    const system = systemOf(requirement);
    for (const project of projectsOf(requirement)) {
      bucketFor(project, system).requirements.push(requirement);
    }
  }
  for (const definition of [...definitions].sort((a, b) => byText(a.td_id, b.td_id))) {
    const project = projectOf(definition);
    for (const system of systemsOf(definition)) {
      bucketFor(project, system).definitions.push(definition);
    }
  }

  const definitionNode = (parentKey: string, definition: TestDefinitionListItem): TreeNode => {
    const key = `${parentKey}/d:${definition.td_id}`;
    const children = [...(runsByDefinition.get(definition.td_id) ?? [])]
      .sort(newestFirst)
      .map((run) => runNode(key, run));
    return {
      kind: "definition",
      key,
      prefix: null,
      label: definition.td_id,
      secondary: definition.title,
      href: `/definitions/${encodeURIComponent(definition.td_id)}`,
      gap: children.length === 0 ? "no run carries it yet" : null,
      hint: null,
      children,
      definition,
    };
  };

  const requirementNode = (parentKey: string, requirement: RequirementRow): TreeNode => {
    const key = `${parentKey}/r:${requirement.req_id}`;
    const children = [...(defIdsByRequirement.get(requirement.req_id) ?? [])]
      .sort(byText)
      .map((tdId) => defById.get(tdId))
      .filter((found): found is TestDefinitionListItem => found !== undefined)
      .map((definition) => definitionNode(key, definition));
    return {
      kind: "requirement",
      key,
      prefix: null,
      label: requirement.req_id,
      secondary: requirement.title,
      href: `/requirements/${encodeURIComponent(requirement.req_id)}`,
      gap: children.length === 0 ? "nothing verifies it" : null,
      hint: null,
      children,
      requirement,
    };
  };

  const systemNode = (
    projectKey: string,
    system: string | null,
    bucket: Bucket,
  ): TreeNode => {
    const key = `${projectKey}/s:${system ?? ""}`;
    const reqGroupKey = `${key}/g:reqs`;
    const defGroupKey = `${key}/g:defs`;
    return {
      kind: "system",
      key,
      prefix: "System",
      label: system ?? "No system",
      secondary: null,
      href: null,
      gap: null,
      hint: system === null ? "Nothing here names a system." : null,
      children: [
        groupNode({
          key: reqGroupKey,
          label: "Requirements",
          href: "/requirements",
          children: bucket.requirements.map((row) => requirementNode(reqGroupKey, row)),
          gap: "none in this system",
        }),
        groupNode({
          key: defGroupKey,
          label: "Test definitions",
          href: "/definitions",
          children: bucket.definitions.map((row) => definitionNode(defGroupKey, row)),
          gap: "none in this system",
          hint: "Each of these also stands under every requirement it verifies.",
        }),
      ],
    };
  };

  const nodes: TreeNode[] = [];
  for (const [project, systems] of [...buckets.entries()].sort((a, b) => nullLast(a[0], b[0]))) {
    const key = `p:${project ?? ""}`;
    nodes.push({
      kind: "project",
      key,
      prefix: "Project",
      label: project ?? "No project",
      secondary: null,
      href: null,
      gap: null,
      hint:
        project === null
          ? "Nothing here names a work order, so no project could be resolved."
          : null,
      children: [...systems.entries()]
        .sort((a, b) => nullLast(a[0], b[0]))
        .map(([system, bucket]) => systemNode(key, system, bucket)),
    });
  }

  if (looseRuns.length > 0) {
    const key = "g:loose-runs";
    nodes.push(
      groupNode({
        key,
        label: "Runs carrying no test definition",
        href: "/runs",
        children: [...looseRuns].sort(newestFirst).map((run) => runNode(key, run)),
        gap: "none",
        hint: "Nothing these produced verifies a requirement until a definition is assigned on the Test Run page.",
      }),
    );
  }

  return nodes;
}

/** The spine a person lands on: every project and system open, the two groups
    under them closed. */
export function defaultOpenKeys(nodes: readonly TreeNode[]): Set<string> {
  const keys = new Set<string>();
  const walk = (level: readonly TreeNode[]): void => {
    for (const node of level) {
      if (node.kind !== "project" && node.kind !== "system") continue;
      keys.add(node.key);
      walk(node.children);
    }
  };
  walk(nodes);
  return keys;
}
