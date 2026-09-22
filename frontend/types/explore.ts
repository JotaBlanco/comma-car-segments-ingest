/**
 * Explore tab contract types.
 *
 *   POST /api/lake/query — the FE's own route handler; the SQL travels
 *     verbatim to the lake, and the run scope and LIMIT live in the SQL text.
 *   GET  /api/v1/test-runs/{run_id}/explore/context — backend route (plan §2,
 *     plans/API-CONTRACT.md §E); feeds the counts and `ai_available`.
 *
 * Rows pass through as the lake returns them — strings, with the timestamp
 * column normalized to ISO-8601 `Z`. The FE renders empty cells as "—"
 * (the NO_STAT convention), never zeros.
 */

export interface ExploreColumn {
  name: string;
}

export interface ExploreQueryRequest {
  sql: string;
}

export interface ExploreQueryResult {
  columns: ExploreColumn[];
  rows: string[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
}

/* ───────────────────────────── Data snippets ─────────────────────────────
 *
 *   GET /api/lake/snippets?table=&run=        — the FE's own route handler; the lake's
 *     `GET /tables/{table}/snippets` narrowed to the run (the run page's anomalies).
 *   GET /api/lake/snippets/{id}/data?table=&limit= — the snippet's rows.
 */

/** A data snippet as the lake keeps it: a named SQL selection, the partition folders it
 *  covers, a Markdown note (QuixLab writes one per finding), tags. */
export interface DataSnippet {
  id: number;
  name: string;
  sql: string;
  partitions: string[];
  markdown: string;
  tags: string[];
  created_at?: string;
  updated_at?: string;
}

export interface RunSnippetsResult {
  table: string;
  run: string;
  snippets: DataSnippet[];
}

export interface SnippetDataResult {
  columns: string[];
  rows: string[][];
  row_count: number;
  limit: number;
}

/**
 * One folder of the lake's partition tree, as `GET /partitions` names it:
 * `name` is the hive folder (`work_order=WO-2026-0915`), `path` the folder's
 * full path under the table. `has_children` says whether a level lies below,
 * so the tree draws a chevron without asking. A VIRTUAL level (indexed, no
 * directory) carries `virtual`.
 */
export interface LakePartitionNode {
  name: string;
  path: string;
  has_children?: boolean;
  file_count?: number;
  size_mb?: number;
  virtual?: boolean;
}

/** `GET /api/lake/partitions` — one level of the tree. */
export interface LakePartitionLevel {
  partitions: LakePartitionNode[];
}

/** `GET /api/lake/partition-values` — one column's distinct values, sorted. */
export interface LakePartitionValues {
  values: string[];
}

export interface ExploreContext {
  /**
   * The LOGICAL table name the backend reports. The workbench ignores it —
   * the editor speaks the PHYSICAL table the server read from
   * `TM_LAKE_TABLE` (`lib/explore/lake-schema.ts`).
   */
  table: string;
  /** Pinned lake projection: run_id, signal, timestamp, value, filename. */
  columns: string[];
  file_count: number;
  signal_count: number;
  /** Nullable — filling it costs a lakeside COUNT(*), so it may be deferred. */
  sample_count: number | null;
  /** Flips the Ask AI mode on/off (Phase 4 — D-E3). */
  ai_available: boolean;
}

/* ─────────────────────────── Ask AI (Phase 4) ───────────────────────────
 *
 *   POST /api/v1/test-runs/{run_id}/explore/chat
 *     body: { message, session_id? }
 *     → application/x-ndjson stream, one JSON object per line, discriminated
 *       on `type`. Every frame carries `session_id` except `ping`.
 *
 * The frame vocabulary mirrors the lakehouse chat protocol (status /
 * answer_delta / tool_* / clarify / ping / error / done).
 */

export interface ExploreChatRequest {
  message: string;
  /** Absent on the first turn; echoed back from the first frame afterwards. */
  session_id?: string | null;
}

export type ExploreChatFrame =
  /** Human-readable progress line ("Reading the signal inventory…"). */
  | { type: "status"; session_id: string; message: string }
  /** A chunk of assistant answer text to append in order. */
  | { type: "answer_delta"; session_id: string; text: string }
  /** A tool call started; open a card. */
  | {
      type: "tool_start";
      session_id: string;
      tool_call_id: string;
      tool_name: string;
      display_name?: string;
    }
  /** A slice of the tool's raw JSON arguments (accumulates). */
  | { type: "tool_args"; session_id: string; tool_call_id: string; delta: string }
  /** The tool's arguments are complete. */
  | { type: "tool_end"; session_id: string; tool_call_id: string }
  /** The tool finished; carries a one-line summary for the card. */
  | {
      type: "tool_result";
      session_id: string;
      tool_call_id: string;
      result?: string;
      summary?: string | null;
      is_error?: boolean;
    }
  /** The assistant needs a decision before it can continue. */
  | { type: "clarify"; session_id: string; question: string; options?: string[] }
  /** Proxy keep-alive — no UI effect, and the only frame without a session. */
  | { type: "ping" }
  /** Turn failed. `session_id` is absent when the client synthesises it. */
  | { type: "error"; session_id?: string; message: string }
  /** Turn complete. */
  | { type: "done"; session_id: string };

/** A tool card shown inside an assistant message. */
export interface ExploreChatTool {
  toolCallId: string;
  /** Display name (falls back to the raw tool name). */
  name: string;
  /** One-line summary from `tool_result` — null while running. */
  meta: string | null;
  running: boolean;
  isError: boolean;
  /** Accumulated raw JSON arguments — internal, used to lift the SQL out. */
  argsRaw: string;
}

/** One rendered chat message (user prompt or assistant turn). */
export interface ExploreChatMessage {
  role: "user" | "assistant";
  /** Streamed answer text (user prompt for user messages). */
  text: string;
  /** The SQL the assistant ran, when it exposed one. */
  sql?: string;
  /** Tool cards collected during the turn. */
  tools?: ExploreChatTool[];
  /** The backend session this message belongs to. */
  sessionId?: string;
}
