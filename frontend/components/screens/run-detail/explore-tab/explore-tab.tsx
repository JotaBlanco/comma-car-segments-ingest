"use client";

/**
 * Explore tab (plan §4) — run-scoped lakeside querying in a multi-tab
 * workbench: any number of SQL / Ask AI / Visualisation tabs (capped at
 * MAX_EXPLORE_TABS), ported from the QuixLake console's tab model.
 *
 * State shape:
 *  - tab list + active id + per-tab SQL live in a pure reducer
 *    (lib/explore/tabs.ts) and persist per run to localStorage, debounced.
 *    Inputs only — results, transcripts and timings are never written.
 *  - each tab's pane owns its heavy state (mutation results, chat stream,
 *    chart config). Panes mount LAZILY on first activation and then stay
 *    mounted but hidden, so switching tabs never loses state and a restored
 *    tab never fires a query the user didn't ask for.
 *  - limitation, on purpose: leaving the Explore tab itself (to Signals,
 *    Files, …) unmounts every pane — SQL text survives via persistence,
 *    results and transcripts do not. Keeping panes alive across the run
 *    tabs would need run-detail-screen.tsx to keep this tab mounted.
 *
 * The tab owns a fixed-height frame that fills the viewport remainder (the
 * page itself never scrolls — run-detail-screen.tsx sizes the outer column and
 * every pane scrolls internally). All panes are absolutely stacked in ONE
 * frame, so switching them causes zero layout shift.
 *
 * Tabs are LOCAL component state, not a URL param — table-state.ts is strictly
 * table machinery (plan §4). Focus (full-screen) state lives one level up in
 * run-detail-screen.tsx, since it also hides the tab row; this tab renders the
 * toggle button and owns the ⇧F / Esc shortcut.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useExploreHistory } from "@/lib/explore/history-store";
import {
  exploreTabsReducer,
  loadTabsState,
  MAX_EXPLORE_TABS,
  newTabId,
  saveTabsState,
  type ExploreTabKind,
  type ExploreTabsState,
} from "@/lib/explore/tabs";
import {
  identityLakeSchema,
  KNOWN_LAKE_TABLES,
  lakeTable,
  resolveLakeSchema,
} from "@/lib/explore/lake-schema";
import { buildSeedSql, buildSnippets } from "@/lib/explore/viz-sql";
import { formatInt } from "@/lib/format";
import { useExploreContext, useRunSignals } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AiPanel } from "./ai-panel";
import { HistoryPanel } from "./history-panel";
import { SqlPane, EDITOR_DEFAULT } from "./sql-pane";
import { SchemaRail, RAIL_DEFAULT } from "./schema-rail";
import type { SqlEditorHandle } from "./sql-editor";
import { TabStrip } from "./tab-strip";

const VizPanel = dynamic(() => import("./viz-panel").then((mod) => mod.VizPanel), {
  ssr: false,
  loading: () => <Skeleton className="h-full min-h-0 w-full" />,
});

/**
 * One fetch for every consumer (rails, snippets, viz). The old 200 ceiling
 * on this route is gone: both the real API and the mock now share one
 * page-size whitelist that ends at 500 (`api/api/models/common.py`
 * ALLOWED_PAGE_SIZES, mirrored in `lib/mock/helpers.ts`). 200 stays as a
 * deliberate choice, not a workaround — it covers every seeded run (the
 * hero run tops out at 186 signals) and keeps the first paint light. A run
 * past 200 signals would need the next allowed step, 500.
 */
const SIGNALS_PAGE_SIZE = 200;

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function FocusButton({ focus, onToggle }: { focus: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={focus}
      onClick={onToggle}
      title="Focus mode — hide the app chrome"
      className="inline-flex h-7 items-center gap-[7px] rounded-md border border-line bg-surface px-2.5 text-[0.74rem] font-semibold text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
    >
      {focus ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 8h3a2 2 0 0 0 2-2V3m13 5h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      )}
      {focus ? "Exit focus" : "Focus"}
      <kbd className="rounded-[3px] border border-line px-1 font-mono text-[0.6rem] text-ink-3">⇧F</kbd>
    </button>
  );
}

interface ExploreTabProps {
  runId: string;
  focus: boolean;
  onToggleFocus: () => void;
}

export function ExploreTab({ runId, focus, onToggleFocus }: ExploreTabProps) {
  const contextQuery = useExploreContext(runId);
  const signalsQuery = useRunSignals(runId, { page_size: SIGNALS_PAGE_SIZE });

  const [state, dispatch] = useReducer(exploreTabsReducer, runId, loadTabsState);

  /* The table the editor speaks: the PHYSICAL table — the server read
     `TM_LAKE_TABLE` at request time and `LakeConfigProvider` handed it
     down, NOT `context.table` (the API's `GET /explore/context` reports the
     LOGICAL name, and no renaming exists between the editor and the lake).
     The context still feeds the counts and `ai_available`. Memoised so the
     memoed children (SqlPane, SchemaRail) see a stable `columns` array. */
  const table = lakeTable();
  const schema = useMemo(() => resolveLakeSchema(table), [table]);

  /* The seed SQL is minted before this component runs, with the builders'
     local-stack fallback schema. Upgrade any tab still holding a KNOWN seed
     variant — the fallback seed with or without the run scope, or a seed
     minted for a different physical table before `TM_LAKE_TABLE` was
     repointed — to the current physical seed. Never SQL a person edited.
     The target seed always carries the run scope in its WHERE line, because
     no server injects it.
     Above the loading early-returns on purpose: hooks must not be conditional. */
  useEffect(() => {
    const target = buildSeedSql(schema, runId);
    if (target === buildSeedSql()) return;
    // Every seed this UI could have minted earlier: each known table's
    // spelling, plus the current table, with and without the run scope.
    // The identity spelling counts too, and not only for a table that is
    // still unmapped: a table sits unmapped for a while and then joins the
    // map, so browsers hold identity-spelled seeds for it that name columns
    // the table does not have. Adding the mapped spelling alone would strand
    // exactly those tabs.
    const untouchedSeeds = new Set<string>();
    for (const known of new Set([...KNOWN_LAKE_TABLES, schema.table])) {
      for (const knownSchema of [resolveLakeSchema(known), identityLakeSchema(known)]) {
        untouchedSeeds.add(buildSeedSql(knownSchema));
        untouchedSeeds.add(buildSeedSql(knownSchema, runId));
      }
    }
    for (const tab of stateRef.current.tabs) {
      const sql = stateRef.current.sqlByTab[tab.id];
      if (sql !== undefined && sql !== target && untouchedSeeds.has(sql)) {
        dispatch({ type: "setSql", id: tab.id, sql: target });
      }
    }
  }, [schema, runId]);
  /** Tabs that have been active at least once — only these mount a pane. */
  const [activatedIds, setActivatedIds] = useState<ReadonlySet<string>>(
    () => new Set([state.activeId]),
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [schemaWidth, setSchemaWidth] = useState(RAIL_DEFAULT);
  const [editorHeight, setEditorHeight] = useState(EDITOR_DEFAULT);

  // Debounced persistence — typing must not write localStorage per keystroke.
  // The trailing write flushes on unmount so a quick tab-away never loses SQL.
  const stateRef = useRef<ExploreTabsState>(state);
  useEffect(() => {
    stateRef.current = state;
    const timer = window.setTimeout(() => saveTabsState(runId, state), 300);
    return () => window.clearTimeout(timer);
  }, [runId, state]);
  useEffect(() => {
    return () => saveTabsState(runId, stateRef.current);
  }, [runId]);

  const history = useExploreHistory(runId);

  // One stable handle box per SQL tab, filled by the tab's SqlEditor while
  // mounted. The docked schema rail inserts through the ACTIVE tab's box —
  // an active viz/ai tab has no box, so insert is a graceful no-op (the rail
  // is hidden on those tabs anyway).
  const editorHandles = useRef(new Map<string, { current: SqlEditorHandle | null }>());
  const editorHandleFor = (id: string): { current: SqlEditorHandle | null } => {
    let box = editorHandles.current.get(id);
    if (box === undefined) {
      box = { current: null };
      editorHandles.current.set(id, box);
    }
    return box;
  };
  const insertIntoActiveEditor = useCallback((text: string) => {
    editorHandles.current.get(stateRef.current.activeId)?.current?.insertAtCursor(text);
  }, []);

  // ⇧F toggles focus; Esc exits focus, else closes history. Ignored while
  // typing in the SQL editor or the AI composer so those keys stay available.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (event.key === "Escape") {
        // Esc inside the editor/composer must stay theirs (dismiss IME,
        // blur, …) — same typing guard as ⇧F below.
        if (typing) return;
        if (focus) {
          event.preventDefault();
          onToggleFocus();
        } else {
          setHistoryOpen(false);
        }
        return;
      }
      if (
        (event.key === "F" || event.key === "f") &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !typing
      ) {
        event.preventDefault();
        onToggleFocus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, onToggleFocus]);

  // Activation is tracked in the event handlers (not an effect): the caller
  // mints the tab id so the lazy-mount set can grow in the same tick. A
  // create refused at the cap leaves a dead id in the set — harmless, it
  // matches no tab and renders nothing.
  const markActive = useCallback((id: string) => {
    setActivatedIds((ids) => (ids.has(id) ? ids : new Set([...ids, id])));
  }, []);
  const onActivate = useCallback(
    (id: string) => {
      markActive(id);
      dispatch({ type: "activate", id });
    },
    [markActive],
  );
  const onClose = useCallback((id: string) => {
    editorHandles.current.delete(id);
    dispatch({ type: "close", id });
  }, []);
  const onRename = useCallback(
    (id: string, title: string) => dispatch({ type: "rename", id, title }),
    [],
  );
  const onReorder = useCallback(
    (id: string, index: number) => dispatch({ type: "reorder", id, index }),
    [],
  );
  const onCreate = useCallback(
    (kind: ExploreTabKind, sql?: string) => {
      const id = newTabId();
      markActive(id);
      dispatch({ type: "create", kind, sql, id });
    },
    [markActive],
  );
  const openInSqlTab = useCallback((sql: string) => onCreate("sql", sql), [onCreate]);
  const openVizTab = useCallback(() => {
    const existing = stateRef.current.tabs.find((tab) => tab.kind === "viz");
    if (existing !== undefined) onActivate(existing.id);
    else onCreate("viz");
  }, [onActivate, onCreate]);

  if (contextQuery.isPending) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (contextQuery.isError) {
    return (
      <ErrorState
        message="Could not load the Explore context for this run."
        onRetry={() => void contextQuery.refetch()}
      />
    );
  }

  // Signals feed the schema rail, the editor snippets and the viz picker —
  // without them the rail claims "0 of N signals" and the picker goes empty
  // with no explanation. Fail loudly with a retry, like the context above.
  if (signalsQuery.isError) {
    return (
      <ErrorState
        message="Could not load this run's signals for Explore."
        onRetry={() => void signalsQuery.refetch()}
      />
    );
  }

  const context = contextQuery.data;
  const signals = signalsQuery.data?.items ?? [];
  const signalNames = signals.map((signal) => signal.name);
  const snippets = buildSnippets(signalNames, schema, runId);
  const atTabCap = state.tabs.length >= MAX_EXPLORE_TABS;
  const activeKind = state.tabs.find((tab) => tab.id === state.activeId)?.kind;

  return (
    <div className="flex h-full min-h-0 flex-col px-5 pt-2.5 pb-3">
      {/* Row 1 — workbench tabs + right-side controls. */}
      <div className="mb-2 flex-none">
        <TabStrip
          tabs={state.tabs}
          activeId={state.activeId}
          aiAvailable={context.ai_available}
          onActivate={onActivate}
          onClose={onClose}
          onCreate={onCreate}
          onRename={onRename}
          onReorder={onReorder}
        >
          <button
            type="button"
            aria-expanded={historyOpen}
            aria-controls="explore-history"
            onClick={() => setHistoryOpen((open) => !open)}
            className={cn(
              "inline-flex h-7 items-center gap-[7px] rounded-md border px-2.5 text-[0.74rem] font-semibold transition-colors",
              historyOpen
                ? "border-accent-soft-border bg-accent-soft text-primary"
                : "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink",
            )}
          >
            History
            {history.length > 0 && (
              <span className="font-mono text-[0.66rem] font-normal text-ink-3">
                {history.length}
              </span>
            )}
          </button>
        </TabStrip>
      </div>

      {/* Row 2 — locked scope + badges + rail/focus controls. */}
      <div className="mb-2.5 flex flex-none flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-[7px] rounded-sm border border-line bg-muted px-2 py-[3px] font-mono text-[0.72rem] text-ink">
          <LockIcon />
          run_id = &apos;{runId}&apos;
        </span>
        <span className="min-w-0 truncate text-[0.74rem] text-ink-3">
          Scoped to this run — <b className="font-semibold text-ink-2">{context.file_count} files</b> ·{" "}
          <b className="font-semibold text-ink-2">{formatInt(context.signal_count)} signals</b>
          {context.sample_count !== null && (
            <>
              {" "}
              · <b className="font-semibold text-ink-2">{formatInt(context.sample_count)} samples</b>
            </>
          )}
        </span>
        <span className="ml-auto flex flex-none items-center gap-[7px]">
          <span className="inline-flex items-center rounded-full border border-accent-soft-border bg-accent-soft px-2.5 py-[3px] text-[0.68rem] font-semibold text-primary">
            computed lakeside
          </span>
          <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-[3px] text-[0.68rem] font-semibold text-ink-3">
            read-only
          </span>
          {/* The rail docks beside the panes but drives the SQL editor
              (click-to-insert), so the toggle only shows when the active tab
              is a SQL one. `schemaOpen` stays up here, so the choice survives
              a detour through a viz tab. */}
          {activeKind === "sql" && (
            <button
              type="button"
              aria-pressed={schemaOpen}
              onClick={() => setSchemaOpen((open) => !open)}
              title="Show the table's columns and this run's signals"
              className="inline-flex h-7 items-center gap-[7px] rounded-md border border-line bg-surface px-2.5 text-[0.74rem] font-semibold text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
            >
              Schema
            </button>
          )}
          <FocusButton focus={focus} onToggle={onToggleFocus} />
        </span>
      </div>

      {/* Docked schema rail (left) + panes + optional docked history (right) —
          the docks push content, they never overlay the app. */}
      <div className="flex min-h-0 flex-1 gap-2.5">
        {schemaOpen && activeKind === "sql" && (
          <SchemaRail
            table={schema.table}
            columns={schema.columns}
            signals={signals}
            signalTotal={context.signal_count}
            width={schemaWidth}
            onWidthChange={setSchemaWidth}
            onInsert={insertIntoActiveEditor}
            onClose={() => setSchemaOpen(false)}
          />
        )}
        <div className="relative min-h-0 min-w-0 flex-1">
          {state.tabs.map((tab) => {
            if (!activatedIds.has(tab.id)) return null;
            const active = tab.id === state.activeId;
            return (
              <div
                key={tab.id}
                role="tabpanel"
                id={`explore-pane-${tab.id}`}
                aria-labelledby={`explore-tab-${tab.id}`}
                className={cn("absolute inset-0 flex min-h-0 flex-col", !active && "hidden")}
              >
                {tab.kind === "sql" && (
                  <SqlPane
                    runId={runId}
                    sql={state.sqlByTab[tab.id] ?? ""}
                    onSqlChange={(sql) => dispatch({ type: "setSql", id: tab.id, sql })}
                    snippets={snippets}
                    editorHandle={editorHandleFor(tab.id)}
                    editorHeight={editorHeight}
                    onEditorHeightChange={setEditorHeight}
                    table={schema.table}
                    columns={schema.columns}
                    signalNames={signalNames}
                  />
                )}
                {tab.kind === "ai" &&
                  (context.ai_available ? (
                    <AiPanel runId={runId} onOpenInSql={openInSqlTab} onVisualise={openVizTab} />
                  ) : (
                    <EmptyState
                      title="Ask AI is not available"
                      message="This deployment has no AI agent configured — the tab's transcript cannot be restored."
                    />
                  ))}
                {tab.kind === "viz" && (
                  <VizPanel
                    runId={runId}
                    signalNames={signalNames}
                    schema={schema}
                    onOpenInSql={openInSqlTab}
                    openInSqlDisabled={atTabCap}
                  />
                )}
              </div>
            );
          })}
        </div>
        {historyOpen && (
          <HistoryPanel
            runId={runId}
            onOpenInTab={openInSqlTab}
            openInTabDisabled={atTabCap}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
