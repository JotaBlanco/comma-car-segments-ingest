"use client";

import { useMemo, useState } from "react";
import { ChevronRight, ClipboardList, FlaskConical, Folder, FolderTree, Timer } from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api/client";
import { sessionTreeColumns } from "@/lib/explore/lake-partitions";
import {
  displayValue,
  entityKind,
  filtersOf,
  parseSegment,
  pathOf,
  type Segment,
} from "@/lib/lake/tree";
import { formatTime } from "@/lib/format";
import { useLakeLevel, useLakeSessions, useRuns, useTestDefinitions, useWorkOrders } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { LakePartitionNode, RunListFilters, TestRunListItem } from "@/types";

/**
 * Pick a workbook's sessions from the LAKE's own partition tree.
 *
 * On the left the tree the data is actually stored in — the levels that
 * address a session (`TM_LAKE_SESSION_PARTITIONS`, `lib/explore/lake-partitions.ts`),
 * read one level at a time from the catalog, so a deep estate opens lazily.
 * Each folder is joined to what the Test Manager knows about it: a work order
 * and a test definition are shown by their title, with the id beside it. On the right the
 * sessions under the folder chosen — one indexed lookup of the session column
 * whatever the depth — each joined to its run row for the time and the status.
 *
 * **Why the lake and not the registry.** The tree used to be the work-order
 * mirror, so it listed work orders that hold no data and hid data that no
 * work order claims. The lake's folders are the data: a folder exists because
 * rows are in it. The registry is the decoration on top, and a session the
 * registry has never heard of still shows, by its id.
 */

/** The node the tree is standing on: the pinned folders, outermost first. `[]` is the whole lake. */
export type SessionNode = readonly Segment[];

const ROW =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8rem] text-ink-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring";

/** How many runs the registry is asked for to decorate one folder's sessions. */
const RUN_PAGE = 500;
/** How many sessions the list draws at once. The lake answers every one of
 *  them in a single call; a folder or the filter reaches past this. */
const LIST_CAP = 500;

function samePath(a: SessionNode, b: SessionNode): boolean {
  return a.length === b.length && a.every((s, i) => s.column === b[i].column && s.value === b[i].value);
}

/** The lake's words for a failure, or a plain sentence when it gave none. */
function lakeMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.detail !== "" ? error.detail : fallback;
}

/** The value is a real id, not one of the lake's "nothing here" spellings. */
function isRealValue(value: string): boolean {
  return displayValue(value) !== "(none)";
}

/**
 * The run-list filters that name the same rows as the picked folder, so the
 * sessions under it are decorated by one call instead of one per session. A
 * folder the registry cannot filter on (a placeholder, an unknown column)
 * contributes nothing and the newest runs decorate what they match.
 */
export function runFilters(node: SessionNode): RunListFilters {
  const filters: RunListFilters = { page_size: RUN_PAGE };
  for (const { column, value } of node) {
    if (!isRealValue(value)) continue;
    const kind = entityKind(column);
    if (kind === "work_order") filters.work_order = value;
    else if (kind === "test_definition") filters.definition = value;
    else if (kind === "project") filters.project = [value];
  }
  return filters;
}

interface Decoration {
  title: string | null;
  icon: typeof Folder;
}

/** What the registry adds to a folder: the entity's title, and an icon for its kind. */
function useEstateLabels() {
  /* Both lists are read once per dialog and cached by the query client: the
     tree joins from them at every level without a call per folder. */
  const workOrders = useWorkOrders({ page_size: 200 });
  const definitions = useTestDefinitions({ page_size: 200 });
  const titles = useMemo(() => {
    const wo = new Map<string, string>();
    for (const w of workOrders.data?.items ?? []) wo.set(w.wo_id, w.title);
    const td = new Map<string, string>();
    for (const d of definitions.data?.items ?? []) td.set(d.td_id, d.title);
    return { wo, td };
  }, [workOrders.data, definitions.data]);
  return (segment: Segment): Decoration => {
    const kind = entityKind(segment.column);
    if (kind === "work_order")
      return { title: titles.wo.get(segment.value) ?? null, icon: ClipboardList };
    if (kind === "test_definition")
      return { title: titles.td.get(segment.value) ?? null, icon: FlaskConical };
    return { title: null, icon: Folder };
  };
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", open && "rotate-90")}
      aria-hidden="true"
    />
  );
}

/**
 * Which folders are open, by path. It is held by the dialog, not by each row,
 * so a level can tell an open branch from a closed one: the filter hides a
 * folder that matches nothing, but never the branch a person opened to get
 * where they are.
 */
interface Opening {
  isOpen(path: string): boolean;
  toggle(path: string): void;
}

/** One folder of the tree, and — once open — the level under it. */
function FolderNode({
  parent,
  node,
  depth,
  picked,
  onPick,
  decorate,
  opening,
  filter,
}: {
  parent: SessionNode;
  node: LakePartitionNode;
  /** How many levels of the session address are above this one. */
  depth: number;
  picked: SessionNode;
  onPick(node: SessionNode): void;
  decorate(segment: Segment): Decoration;
  opening: Opening;
  filter: string;
}) {
  const segment = parseSegment(node.name);
  if (segment === null) return null;
  const me: SessionNode = [...parent, segment];
  const open = opening.isOpen(pathOf(me));
  const setOpen = () => opening.toggle(pathOf(me));
  const on = samePath(picked, me);
  const { title, icon: Icon } = decorate(segment);
  /* The last session level IS the session, and the right pane lists those.
     A chevron below it would walk into the data inside a run, which is the
     Explorer's tree, not this one. */
  const expandable = depth + 1 < sessionTreeColumns().length && node.has_children !== false;
  const label = displayValue(segment.value);
  return (
    <li>
      <div className={cn(ROW, on && "bg-accent-soft text-primary")}>
        {expandable ? (
          <button
            type="button"
            className="-ml-1 grid size-5 place-items-center rounded hover:bg-muted"
            aria-expanded={open}
            aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
            onClick={setOpen}
          >
            <Chevron open={open} />
          </button>
        ) : (
          <span className="-ml-1 size-5" aria-hidden="true" />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-current={on ? "true" : undefined}
          onClick={() => {
            onPick(me);
            if (expandable && !open) setOpen();
          }}
        >
          <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{title ?? label}</span>
          {title !== null && <span className="font-mono text-[0.68rem] text-ink-3">{label}</span>}
        </button>
      </div>
      {open && expandable && (
        <ul className="ml-4 border-l border-line pl-1">
          <Level
            parent={me}
            depth={depth + 1}
            picked={picked}
            onPick={onPick}
            decorate={decorate}
            opening={opening}
            filter={filter}
          />
        </ul>
      )}
    </li>
  );
}

/** One level of the lake's tree: the folders under `parent`, read when it opens. */
function Level({
  parent,
  depth,
  picked,
  onPick,
  decorate,
  opening,
  filter,
}: {
  parent: SessionNode;
  depth: number;
  picked: SessionNode;
  onPick(node: SessionNode): void;
  decorate(segment: Segment): Decoration;
  opening: Opening;
  /** Typed text, applied to every loaded level: the id, and the title joined to it. */
  filter: string;
}) {
  const level = useLakeLevel(pathOf(parent));
  const needle = filter.trim().toLowerCase();
  const nodes = (level.data?.partitions ?? []).filter((node) => {
    if (needle === "") return true;
    const segment = parseSegment(node.name);
    if (segment === null) return false;
    /* An open folder stays: it is the branch someone walked down, and what
       they are looking for may be under it rather than in its own name. */
    if (opening.isOpen(pathOf([...parent, segment]))) return true;
    const title = decorate(segment).title ?? "";
    return `${segment.value} ${title}`.toLowerCase().includes(needle);
  });
  if (level.isPending) return <li className="py-1 pl-2 text-[0.76rem] text-ink-3">Loading…</li>;
  if (level.isError)
    return (
      <li className="py-1 pl-2 text-[0.76rem] text-red">
        {lakeMessage(level.error, "Could not read the lake's folders.")}
      </li>
    );
  if (nodes.length === 0)
    return <li className="py-1 pl-2 text-[0.76rem] text-ink-3">No folders here.</li>;
  return (
    <>
      {nodes.map((node) => (
        <FolderNode
          key={node.name}
          parent={parent}
          node={node}
          depth={depth}
          picked={picked}
          onPick={onPick}
          decorate={decorate}
          opening={opening}
          filter={filter}
        />
      ))}
    </>
  );
}

/** The picked folder, as a person reads it: the deepest level's title, or the whole lake. */
function nodeTitle(node: SessionNode, decorate: (segment: Segment) => Decoration): string {
  const last = node[node.length - 1];
  if (last === undefined) return "All sessions";
  return decorate(last).title ?? displayValue(last.value);
}

/** Newest first: the registry's time when it knows the run, then the id, high to low. */
export function sortSessions(values: readonly string[], runs: ReadonlyMap<string, TestRunListItem>): string[] {
  return [...values].sort((a, b) => {
    const ta = Date.parse(runs.get(a)?.first_data_at ?? "");
    const tb = Date.parse(runs.get(b)?.first_data_at ?? "");
    const ka = Number.isNaN(ta) ? null : ta;
    const kb = Number.isNaN(tb) ? null : tb;
    if (ka !== null && kb !== null && ka !== kb) return kb - ka;
    if (ka !== null && kb === null) return -1;
    if (ka === null && kb !== null) return 1;
    return b.localeCompare(a, undefined, { numeric: true });
  });
}

/** The sessions under the picked folder, each with its box. */
function SessionList({
  node,
  selected,
  multi,
  onToggle,
  decorate,
}: {
  node: SessionNode;
  selected: readonly string[];
  /** True when several sessions may be picked; false picks one at a time. */
  multi: boolean;
  onToggle(runId: string, on: boolean): void;
  decorate(segment: Segment): Decoration;
}) {
  const [q, setQ] = useState("");
  const lake = useLakeSessions(filtersOf(node));
  const registry = useRuns(runFilters(node), { poll: false });
  const byId = useMemo(() => {
    const map = new Map<string, TestRunListItem>();
    for (const run of registry.data?.items ?? []) map.set(run.run_id, run);
    return map;
  }, [registry.data]);
  const needle = q.trim().toLowerCase();
  const matching = sortSessions(lake.data?.values ?? [], byId).filter((id) =>
    needle === "" ? true : id.toLowerCase().includes(needle),
  );
  const sessions = matching.slice(0, LIST_CAP);
  const more = matching.length - sessions.length;
  const all = sessions.length > 0 && sessions.every((id) => selected.includes(id));
  return (
    <div className="flex min-h-0 flex-col" role="region" aria-label="Sessions">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[0.72rem] font-semibold tracking-wider text-ink-3 uppercase">
        <span className="min-w-0 truncate">{nodeTitle(node, decorate)}</span>
        <span className="ml-auto font-mono normal-case tracking-normal">
          {matching.length} {matching.length === 1 ? "session" : "sessions"}
        </span>
      </div>
      <input
        className="m-2 h-8 rounded-md border border-line bg-surface px-2 text-[0.8rem] outline-none focus-visible:border-primary"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter sessions…"
        aria-label="Filter sessions"
      />
      {lake.isPending && <p className="p-3 text-[0.78rem] text-ink-3">Loading…</p>}
      {lake.isError && (
        <p className="p-3 text-[0.78rem] text-red">
          {lakeMessage(lake.error, "Could not read the sessions from the lake.")}
        </p>
      )}
      {!lake.isPending && !lake.isError && sessions.length === 0 && (
        <p className="p-3 text-[0.78rem] text-ink-3">
          {needle === "" ? "No sessions here yet." : "No session here matches that."}
        </p>
      )}
      {more > 0 && (
        <p className="border-b border-line-2 px-3 py-1.5 text-[0.72rem] text-ink-3">
          The first {sessions.length} of {matching.length}. Pick a folder on the left, or filter, to
          reach the rest.
        </p>
      )}
      {multi && sessions.length > 1 && (
        <label className="flex cursor-pointer items-center gap-2.5 border-b border-line-2 px-3 py-1.5 text-[0.76rem] text-ink-2">
          <Checkbox
            checked={all}
            onCheckedChange={(on: boolean) => {
              for (const id of sessions) onToggle(id, on);
            }}
          />
          <span>Select all</span>
        </label>
      )}
      <ul className="min-h-0 overflow-auto">
        {sessions.map((id) => {
          const on = selected.includes(id);
          const run = byId.get(id);
          return (
            <li key={id}>
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[0.78rem] hover:bg-surface-2",
                  on && "bg-accent-soft/60",
                )}
              >
                {multi ? (
                  <Checkbox
                    checked={on}
                    onCheckedChange={(next: boolean) => onToggle(id, next)}
                    aria-label={`Select ${id}`}
                  />
                ) : (
                  <input
                    type="radio"
                    name="session"
                    className="size-3.5 accent-primary"
                    checked={on}
                    onChange={() => onToggle(id, true)}
                    aria-label={`Select ${id}`}
                  />
                )}
                <Timer className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-[0.76rem]">{id}</span>
                {run !== undefined && (
                  <span className="font-mono text-[0.68rem] text-ink-3">
                    {formatTime(run.first_data_at)}
                  </span>
                )}
                {run !== undefined ? (
                  <StatusBadge status={run.status} />
                ) : (
                  <span
                    className="text-[0.68rem] text-ink-3"
                    title="The lake holds this session; the registry has no run by that id."
                  >
                    lake only
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SessionsDialog({
  selected,
  onChange,
  onClose,
  multiDefault = false,
}: {
  selected: readonly string[];
  onChange(sessions: readonly string[]): void;
  onClose(): void;
  /** Start with several sessions allowed. The Explorer merges them, so it does. */
  multiDefault?: boolean;
}) {
  const [q, setQ] = useState("");
  /* The root is picked from the start, so the sessions are on screen without a click. */
  const [node, setNode] = useState<SessionNode>([]);
  const [multi, setMulti] = useState(multiDefault || selected.length > 1);
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set<string>());
  const decorate = useEstateLabels();
  const levels = sessionTreeColumns();
  const opening: Opening = {
    isOpen: (path) => openPaths.has(path),
    toggle: (path) =>
      setOpenPaths((was) => {
        const next = new Set(was);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
  };
  const toggle = (runId: string, on: boolean) => {
    if (!multi) {
      onChange(on ? [runId] : []);
      return;
    }
    if (on) onChange(selected.includes(runId) ? selected : [...selected, runId]);
    else onChange(selected.filter((s) => s !== runId));
  };
  /* Leaving multiple behind keeps the first pick, so the state always matches the control. */
  const setMultiple = (on: boolean) => {
    setMulti(on);
    if (!on && selected.length > 1) onChange([selected[0]]);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[92dvh] w-[96vw] max-w-[96vw] flex-col rounded-[10px] p-5 sm:max-w-[96vw]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">Sessions</DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            Pick the test run this workbook works on, from the lake&apos;s own folders. Turn on
            Multiple sessions to pick several: they fill the session dropdown, and the first one
            opens when none is.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-3 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
          <div className="flex min-h-0 flex-col rounded-md border border-line">
            <input
              className="m-2 h-8 rounded-md border border-line bg-surface px-2 text-[0.8rem] outline-none focus-visible:border-primary"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter folders…"
              aria-label="Filter folders"
            />
            <nav aria-label="Lake folders" className="min-h-0 flex-1 overflow-auto px-1 pb-1">
              <ul>
                <li>
                  <button
                    type="button"
                    className={cn(ROW, "font-semibold", node.length === 0 && "bg-accent-soft text-primary")}
                    aria-current={node.length === 0 ? "true" : undefined}
                    onClick={() => setNode([])}
                  >
                    <FolderTree className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">All sessions</span>
                  </button>
                </li>
                {levels.length > 0 && (
                  <Level
                    parent={[]}
                    depth={0}
                    picked={node}
                    onPick={setNode}
                    decorate={decorate}
                    opening={opening}
                    filter={q}
                  />
                )}
              </ul>
            </nav>
          </div>
          <div className="flex min-h-0 flex-col rounded-md border border-line">
            <SessionList
              node={node}
              selected={selected}
              multi={multi}
              onToggle={toggle}
              decorate={decorate}
            />
          </div>
        </div>
        <DialogFooter className="mt-4 items-center">
          <label className="mr-auto flex cursor-pointer items-center gap-2.5 text-[0.78rem] text-ink-2">
            <Checkbox checked={multi} onCheckedChange={setMultiple} />
            <span>Multiple sessions</span>
            <span className="text-ink-3">
              · {selected.length} {selected.length === 1 ? "session" : "sessions"} selected
            </span>
          </label>
          {selected.length > 0 && (
            <Button type="button" variant="outline" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}