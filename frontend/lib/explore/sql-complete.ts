/**
 * Completion vocabulary + caret-context analysis for the SQL editor's
 * intellisense popup. Pure — no DOM, no React — unit-tested in node.
 *
 * The Explore surface is exactly one table and five columns, so the
 * vocabulary is CLOSED: keywords, the table, its columns, and this run's
 * signal names. The table and column entries are the PHYSICAL spellings —
 * the caller resolves the server-read `TM_LAKE_TABLE` through
 * lib/explore/lake-schema.ts (this front end owns that column map; no
 * backend guard exists any more) and threads the result in, so completion
 * offers the identifiers the lake actually resolves (e.g. `ts_ms` /
 * `file_name` on `test_signal_samples_v3`). Other table names stay out on
 * purpose: the SQL goes to the lake verbatim, so anything could be typed,
 * but this UI only knows the schema of its own table — offering names it
 * cannot describe would be guessing.
 */

import { EXPLORE_COLUMN_TYPES } from "./schema";
import { sqlQuote } from "./viz-sql";

export type SqlSuggestionKind = "keyword" | "function" | "table" | "column" | "signal";

export interface SqlSuggestion {
  /** Text shown in the popup and matched against the typed prefix. */
  label: string;
  /** Exact text spliced into the editor (keywords uppercase, signals quoted). */
  insert: string;
  kind: SqlSuggestionKind;
  /** Right-hand hint in the popup (column type, "table", "signal", …). */
  detail: string | null;
}

/**
 * Keywords offered by completion — the highlighter's KEYWORDS set plus the
 * compound `GROUP BY` / `ORDER BY` forms its single-word tokeniser can't hold.
 */
const KEYWORD_COMPLETIONS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "LIMIT", "AND", "OR",
  "NOT", "IN", "BETWEEN", "AS", "LIKE", "IS", "NULL", "DESC", "ASC",
  "DISTINCT", "HAVING", "CASE", "WHEN", "THEN", "ELSE", "END", "INTERVAL",
  "SECOND", "MILLISECOND", "MINUTE", "HOUR",
] as const;

/** Aggregates/functions the snippets and viz SQL already lean on. */
const FUNCTION_COMPLETIONS = ["avg", "min", "max", "count", "abs", "time_bucket"] as const;

export interface CompletionQuery {
  /** Replacement range in the editor value (end may extend past the caret
   *  to swallow an existing closing quote). */
  start: number;
  end: number;
  /** The typed prefix being completed — matched case-insensitively. */
  prefix: string;
  /** True when the caret sits where a signal STRING literal belongs. */
  signalPosition: boolean;
}

const WORD_TAIL_RE = /[A-Za-z0-9_]+$/;

/** Analyze the caret's surroundings into a replacement range + context. */
export function completionQueryAt(value: string, caret: number): CompletionQuery {
  const head = value.slice(0, caret);

  // Odd quote parity = the caret is inside an open string literal ('' escapes
  // count as two quotes, so parity stays truthful). Complete the WHOLE
  // literal, quotes included, so accepting always yields a well-formed one.
  const quoteCount = (head.match(/'/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    const open = head.lastIndexOf("'");
    return {
      start: open,
      end: caret + (value.charAt(caret) === "'" ? 1 : 0),
      prefix: head.slice(open + 1),
      signalPosition: true,
    };
  }

  const prefix = WORD_TAIL_RE.exec(head)?.[0] ?? "";
  const start = caret - prefix.length;
  const before = head.slice(0, start);
  const signalPosition =
    /\bsignal\s*(=|!=|<>)\s*$/i.test(before) || /\bin\s*\(\s*$/i.test(before);
  return { start, end: caret, prefix, signalPosition };
}

export interface CompletionVocabulary {
  table: string | null;
  columns: readonly string[];
  signals: readonly string[];
}

/** Build the (already filtered) suggestion list for a completion query. */
export function buildCompletions(
  query: CompletionQuery,
  vocab: CompletionVocabulary,
): SqlSuggestion[] {
  const all: SqlSuggestion[] = [];
  if (query.signalPosition) {
    // Only a signal value fits here — a closed context, so nothing else.
    for (const name of vocab.signals) {
      all.push({ label: name, insert: sqlQuote(name), kind: "signal", detail: "signal" });
    }
  } else {
    for (const column of vocab.columns) {
      all.push({
        label: column,
        insert: column,
        kind: "column",
        detail: EXPLORE_COLUMN_TYPES[column] ?? null,
      });
    }
    if (vocab.table !== null) {
      all.push({ label: vocab.table, insert: vocab.table, kind: "table", detail: "table" });
    }
    for (const keyword of KEYWORD_COMPLETIONS) {
      all.push({ label: keyword, insert: keyword, kind: "keyword", detail: null });
    }
    for (const fn of FUNCTION_COMPLETIONS) {
      all.push({ label: fn, insert: fn, kind: "function", detail: "function" });
    }
    // Signals are VALUES of the signal column — offered quoted everywhere,
    // matching the schema rail's click-to-insert convention.
    for (const name of vocab.signals) {
      all.push({ label: name, insert: sqlQuote(name), kind: "signal", detail: "signal" });
    }
  }
  const prefix = query.prefix.toLowerCase();
  if (prefix === "") return all;
  return all.filter((item) => item.label.toLowerCase().startsWith(prefix));
}
