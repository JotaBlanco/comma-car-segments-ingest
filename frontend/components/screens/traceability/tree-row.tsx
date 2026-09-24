"use client";

import Link from "next/link";
import {
  Boxes,
  ChevronRight,
  Cpu,
  FlaskConical,
  Folder,
  ListChecks,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { VerificationChip } from "@/components/screens/requirements/verification-chip";
import { DefinitionStatusBadge, StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { formatArrival } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TreeKind, TreeNode } from "./traceability-model";

/** Which rows are open, held by the screen so a whole branch has one answer. */
export interface Opening {
  isOpen(key: string): boolean;
  toggle(key: string): void;
}

const ICONS: Record<TreeKind, LucideIcon> = {
  project: Boxes,
  system: Cpu,
  group: Folder,
  requirement: ListChecks,
  definition: FlaskConical,
  run: Timer,
};

const NOUNS: Record<TreeKind, [string, string]> = {
  project: ["project", "projects"],
  system: ["system", "systems"],
  group: ["group", "groups"],
  requirement: ["requirement", "requirements"],
  definition: ["test definition", "test definitions"],
  run: ["test run", "test runs"],
};

const MONO_KINDS: ReadonlySet<TreeKind> = new Set<TreeKind>(["requirement", "definition", "run"]);

/** "10 requirements" — the kind of the children, counted. */
function childCount(node: TreeNode): string | null {
  const first = node.children[0];
  if (first === undefined) return null;
  const [one, many] = NOUNS[first.kind];
  return `${node.children.length} ${node.children.length === 1 ? one : many}`;
}

function Facts({ node }: { node: TreeNode }) {
  if (node.kind === "requirement") {
    return (
      <VerificationChip
        state={node.requirement.verification_state}
        stale={node.requirement.evidence_stale}
      />
    );
  }
  if (node.kind === "definition") {
    return (
      <>
        {node.definition.orphaned && (
          <ToneBadge tone="amber" dot>
            Orphaned
          </ToneBadge>
        )}
        <DefinitionStatusBadge status={node.definition.status} />
        <span className="font-mono text-[0.7rem] text-ink-3">
          {node.definition.actual_runs}/{node.definition.planned_runs} runs
        </span>
      </>
    );
  }
  if (node.kind === "run") {
    return (
      <>
        <span className="font-mono text-[0.7rem] text-ink-3">{node.run.rig_id}</span>
        <StatusBadge status={node.run.status} />
        <span className="text-[0.7rem] text-ink-3">{formatArrival(node.run.first_data_at)}</span>
      </>
    );
  }
  return null;
}

/**
 * One row and, when it is open, the level under it.
 *
 * The chevron and the name are two controls: the chevron discloses, the name
 * navigates. A folder row names no page, so its name toggles instead.
 */
export function TreeRow({ node, opening }: { node: TreeNode; opening: Opening }) {
  const expandable = node.children.length > 0;
  const open = expandable && opening.isOpen(node.key);
  const toggle = () => opening.toggle(node.key);
  const Icon = ICONS[node.kind];
  const count = childCount(node);
  const nameClass = cn(
    "shrink-0 font-semibold",
    MONO_KINDS.has(node.kind) && "font-mono text-[0.78rem] font-medium",
  );

  return (
    <li>
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.8rem] hover:bg-surface-2">
        {expandable ? (
          <button
            type="button"
            className="-ml-1 grid size-5 shrink-0 place-items-center rounded hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
            onClick={toggle}
          >
            <ChevronRight
              className={cn("size-3.5 text-ink-3 transition-transform", open && "rotate-90")}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="-ml-1 size-5 shrink-0" aria-hidden="true" />
        )}
        <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
        {node.prefix !== null && (
          <span className="shrink-0 text-[0.65rem] font-semibold tracking-[0.09em] text-ink-3 uppercase">
            {node.prefix}
          </span>
        )}
        {node.href !== null ? (
          <Link
            href={node.href}
            className={cn(nameClass, "rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring")}
          >
            {node.label}
          </Link>
        ) : expandable ? (
          <button type="button" onClick={toggle} className={cn(nameClass, "text-left")}>
            {node.label}
          </button>
        ) : (
          <span className={nameClass}>{node.label}</span>
        )}
        {node.secondary !== null && node.secondary !== "" && (
          <span className="min-w-0 truncate text-ink-2">{node.secondary}</span>
        )}
        {node.gap !== null && (
          <span className="shrink-0 text-[0.72rem] text-ink-3 italic">— {node.gap}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {count !== null && <span className="text-[0.7rem] text-ink-3">{count}</span>}
          <Facts node={node} />
        </span>
      </div>
      {open && (
        <ul className="ml-4 border-l border-line pl-1">
          {node.hint !== null && (
            <li className="px-2 py-1 text-[0.72rem] text-ink-3">{node.hint}</li>
          )}
          {node.children.map((child) => (
            <TreeRow key={child.key} node={child} opening={opening} />
          ))}
        </ul>
      )}
    </li>
  );
}
