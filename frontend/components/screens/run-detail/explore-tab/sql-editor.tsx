"use client";

/**
 * Ghost-textarea SQL editor (plan §4 — zero-dependency highlighting).
 *
 * A transparent-text <textarea> sits over a syntax-colored <pre>; both share
 * the same mono metrics and are scroll-synced, so the caret and selection
 * live in the real control while the colors come from the layer behind it.
 * Syntax tones are the AA-cleared --syn-* tokens (globals.css, both themes).
 *
 * Ctrl/Cmd+Enter runs the query. A failed statement shows nothing here:
 * the SQL goes to the lake verbatim, so every error — DuckDB refusals
 * included — surfaces in the results panel's error state, not inline.
 *
 * Completion: a closed vocabulary (one table, five columns, this run's
 * signals, keywords — see lib/explore/sql-complete.ts) feeds a hand-rolled
 * caret-anchored listbox — deliberately NOT Base UI, this file stays
 * zero-dependency. Opens while typing a word or on Ctrl+Space; ArrowUp/Down
 * + Enter/Tab accept; Escape dismisses without reaching the workbench's Esc
 * bindings.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import { Kbd } from "@/components/shared/kbd";
import { Button } from "@/components/ui/button";
import { measureCaret } from "@/lib/explore/caret-position";
import {
  buildCompletions,
  completionQueryAt,
  type SqlSuggestion,
} from "@/lib/explore/sql-complete";
import type { SqlSnippet } from "@/lib/explore/viz-sql";
import { cn } from "@/lib/utils";

/** Imperative surface for callers that insert text (the schema rail). */
export interface SqlEditorHandle {
  insertAtCursor(text: string): void;
}

const KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "as", "in", "and", "or", "not",
  "with", "limit", "between", "like", "is", "null", "desc", "asc", "join", "left",
  "right", "inner", "on", "having", "union", "all", "distinct", "case", "when",
  "then", "else", "end", "interval", "second", "millisecond", "minute", "hour",
]);

const TOKEN_RE = /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

/** Tokenize SQL into colored spans for the ghost layer. */
export function highlightSql(sql: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of sql.matchAll(TOKEN_RE)) {
    const index = match.index;
    if (index > last) nodes.push(sql.slice(last, index));
    const [text, comment, str, num, word] = match;
    if (comment !== undefined) {
      nodes.push(
        <span key={key++} className="italic" style={{ color: "var(--syn-com)" }}>
          {text}
        </span>,
      );
    } else if (str !== undefined) {
      nodes.push(
        <span key={key++} style={{ color: "var(--syn-str)" }}>
          {text}
        </span>,
      );
    } else if (num !== undefined) {
      nodes.push(
        <span key={key++} style={{ color: "var(--syn-num)" }}>
          {text}
        </span>,
      );
    } else if (word !== undefined && KEYWORDS.has(word.toLowerCase())) {
      nodes.push(
        <span key={key++} className="font-semibold" style={{ color: "var(--syn-kw)" }}>
          {text}
        </span>,
      );
    } else {
      nodes.push(text);
    }
    last = index + text.length;
  }
  if (last < sql.length) nodes.push(sql.slice(last));
  return nodes;
}

interface SqlEditorProps {
  value: string;
  onChange: (sql: string) => void;
  onRun: () => void;
  running: boolean;
  snippets: SqlSnippet[];
  /** Optional out-ref the caller can use to insert text at the caret. */
  handleRef?: { current: SqlEditorHandle | null };
  /** Completion vocabulary — the PHYSICAL lake table and its five columns. */
  table?: string;
  columns?: readonly string[];
  /** This run's signal names — completed QUOTED, like the schema rail. */
  signals?: readonly string[];
}

/** Popup width (px) — the anchor clamp keeps it inside the editor. */
const COMPLETION_WIDTH = 264;

interface CompletionState {
  items: SqlSuggestion[];
  index: number;
  /** Replacement range within `source`. */
  start: number;
  end: number;
  /** Value snapshot the range refers to — accepting splices this snapshot,
   *  so a not-yet-round-tripped controlled value can never corrupt it. */
  source: string;
  /** Popup anchor in px, relative to the editor's positioning box. */
  top: number;
  left: number;
}

const editorMetrics =
  "px-4 py-3.5 font-mono text-[0.78rem] leading-[1.7] whitespace-pre";

export function SqlEditor({
  value,
  onChange,
  onRun,
  running,
  snippets,
  handleRef,
  table,
  columns = [],
  signals = [],
}: SqlEditorProps) {
  const ghostRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listboxId = useId();
  const [completion, setCompletion] = useState<CompletionState | null>(null);

  /** Analyze `source` at `caret`; null = nothing to show. Explicit invocation
   *  (Ctrl+Space) also opens on an empty prefix; typing needs ≥1 char. */
  const computeCompletion = (
    source: string,
    caret: number,
    explicit: boolean,
  ): CompletionState | null => {
    const query = completionQueryAt(source, caret);
    if (!explicit && query.prefix.length === 0) return null;
    const items = buildCompletions(query, { table: table ?? null, columns, signals });
    if (items.length === 0) return null;
    let top = 0;
    let left = 0;
    const area = textareaRef.current;
    if (area !== null) {
      const coords = measureCaret(area, query.start);
      // jsdom measures 0 everywhere — fall back to one line so the popup
      // still clears the first line instead of covering it.
      top = coords.top + (coords.lineHeight > 0 ? coords.lineHeight : 20);
      left = Math.max(0, Math.min(coords.left, area.clientWidth - COMPLETION_WIDTH));
    }
    return { items, index: 0, start: query.start, end: query.end, source, top, left };
  };

  const acceptSuggestion = (item: SqlSuggestion) => {
    if (completion === null) return;
    const { source, start, end } = completion;
    onChange(source.slice(0, start) + item.insert + source.slice(end));
    setCompletion(null);
    const area = textareaRef.current;
    // Same post-splice focus/caret machinery as insertAtCursor above.
    requestAnimationFrame(() => {
      if (area === null) return;
      area.focus();
      const caret = start + item.insert.length;
      area.setSelectionRange(caret, caret);
    });
  };

  // Keep the active option visible; jsdom has no scrollIntoView, hence `?.`.
  useEffect(() => {
    if (completion === null) return;
    document.getElementById(`${listboxId}-${completion.index}`)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [completion, listboxId]);

  // No dependency array on purpose: the handle closes over the current value
  // and onChange, so it must be refreshed every render to stay in step.
  useEffect(() => {
    if (handleRef === undefined) return;
    handleRef.current = {
      insertAtCursor(text: string) {
        const area = textareaRef.current;
        if (area === null) return;
        const start = area.selectionStart ?? value.length;
        const end = area.selectionEnd ?? start;
        onChange(value.slice(0, start) + text + value.slice(end));
        requestAnimationFrame(() => {
          area.focus();
          const caret = start + text.length;
          area.setSelectionRange(caret, caret);
        });
      },
    };
    return () => {
      handleRef.current = null;
    };
  });

  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const ghost = ghostRef.current;
    if (ghost === null) return;
    ghost.scrollTop = event.currentTarget.scrollTop;
    ghost.scrollLeft = event.currentTarget.scrollLeft;
  };

  const empty = value.trim().length === 0;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.ctrlKey && (event.key === " " || event.code === "Space")) {
      event.preventDefault();
      const area = event.currentTarget;
      setCompletion(computeCompletion(area.value, area.selectionStart ?? area.value.length, true));
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setCompletion(null);
      if (!running && !empty) onRun();
      return;
    }
    if (completion === null) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const count = completion.items.length;
        setCompletion({ ...completion, index: (completion.index + delta + count) % count });
        return;
      }
      case "Enter":
      case "Tab": {
        event.preventDefault();
        const item = completion.items[completion.index];
        if (item !== undefined) acceptSuggestion(item);
        return;
      }
      case "Escape":
        // Must never leak: the workbench binds Esc to exit focus mode and
        // close docked panels — with the popup open, dismissal is this
        // key's whole job.
        event.preventDefault();
        event.stopPropagation();
        setCompletion(null);
        return;
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        // The caret is leaving the word the popup was computed for.
        setCompletion(null);
        return;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-line bg-surface shadow-tm">
      <div className="relative min-h-0 flex-1">
        <pre
          ref={ghostRef}
          aria-hidden
          className={cn(
            editorMetrics,
            "pointer-events-none absolute inset-0 overflow-hidden text-ink",
          )}
        >
          {/* Nothing at all when empty so the textarea's placeholder shows
              through cleanly; else the trailing newline keeps the ghost
              layer's height in step. */}
          {value.length > 0 && (
            <>
              {highlightSql(value)}
              {"\n"}
            </>
          )}
        </pre>
        <textarea
          ref={textareaRef}
          aria-label="SQL editor"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next);
            // Filter (or open) from the word at the new caret on every edit.
            setCompletion(
              computeCompletion(next, event.target.selectionStart ?? next.length, false),
            );
          }}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onBlur={() => setCompletion(null)}
          /* The editor drives a filtered suggestion list, which is the ARIA
             combobox pattern — and the only role that allows aria-expanded /
             aria-activedescendant on this element (axe aria-allowed-attr). */
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={completion !== null}
          aria-controls={completion !== null ? listboxId : undefined}
          aria-activedescendant={
            completion !== null ? `${listboxId}-${completion.index}` : undefined
          }
          wrap="off"
          // Native placeholder for a fresh empty tab; the ghost layer renders
          // nothing for empty SQL, so the two never overlap. The textarea's
          // own text is transparent (the ghost paints it), so the placeholder
          // needs an explicit color back.
          placeholder="Enter a SQL query — it runs scoped to this run"
          className={cn(
            editorMetrics,
            "absolute inset-0 block h-full w-full resize-none overflow-auto bg-transparent text-transparent outline-none",
            "placeholder:text-ink-3",
            "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
          )}
          style={{ caretColor: "var(--ink)" }}
        />
        {completion !== null && (
          <ul
            role="listbox"
            id={listboxId}
            aria-label="SQL suggestions"
            style={{ top: completion.top, left: completion.left, width: COMPLETION_WIDTH }}
            className="absolute z-10 max-h-52 overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-tm"
          >
            {completion.items.map((item, index) => (
              <li
                key={`${item.kind}:${item.label}`}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === completion.index}
                // Mousedown would blur the textarea (closing the popup before
                // click lands) — accept on mousedown and keep focus put.
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptSuggestion(item);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-3 px-2.5 py-1 font-mono text-[0.72rem] text-ink-2",
                  index === completion.index && "bg-accent-soft text-primary",
                )}
              >
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {item.label}
                </span>
                {item.detail !== null && (
                  <span className="ml-auto flex-none text-[0.62rem] text-ink-3">
                    {item.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-none flex-wrap items-center gap-2.5 border-t border-line-2 bg-surface-2 px-3 py-[9px]">
        <Button
          size="sm"
          className="font-semibold"
          onClick={onRun}
          disabled={running || empty}
          aria-busy={running}
        >
          {running ? "Running…" : "Run query"}
          <Kbd
            keyLabel="↵"
            className="rounded-[3px] border-white/35 bg-transparent px-1 py-0 text-[0.6rem] font-medium opacity-75"
          />
        </Button>
        <span className="text-[0.72rem] text-ink-3">
          add <code className="font-mono text-ink-2">LIMIT</code> in your query
        </span>
        <div className="flex flex-wrap gap-[7px]" aria-label="Query snippets">
          {snippets.map((snippet) => (
            <button
              key={snippet.label}
              type="button"
              className="rounded-full border border-line bg-surface px-3 py-1 text-[0.72rem] font-semibold text-ink-2 transition-colors hover:border-accent-soft-border hover:bg-accent-soft hover:text-primary"
              onClick={() => onChange(snippet.sql)}
            >
              {snippet.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
