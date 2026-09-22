/**
 * Registry assistant contract types (plans/design/AI-SIDEBAR.md §6).
 *
 *   GET  /api/v1/assistant/status → { enabled, reachable }
 *   POST /api/v1/assistant/chat   → application/x-ndjson stream, one JSON
 *        object per line, discriminated on `type`. Every frame carries
 *        `session_id` (the client-synthesised `error` frame may omit it).
 *
 * Answers are structured frames, never markdown prose: `hits`, `deeplink` and
 * `chain` are server-hydrated from real registry rows — the FE renders them,
 * it never linkifies `text` and never invents card content.
 */

import type { RunStatus } from "./test-run";

export interface AssistantStatus {
  enabled: boolean;
  reachable: boolean;
}

export interface AssistantChatRequest {
  message: string;
  /** Absent on the first turn; echoed back from the first frame afterwards. */
  session_id?: string | null;
}

/** The quoted journal record behind an invalid/quarantine hit. */
export interface AssistantHitReason {
  text: string;
  actor: string;
  at: string;
  journal_id: string;
}

/** One server-hydrated entity card. `run` is the only entity in v1. */
export interface AssistantHit {
  entity: "run";
  run_id: string;
  status: RunStatus;
  rig_id: string | null;
  project: string | null;
  first_data_at: string | null;
  /** App-relative — the FE refuses anything that does not start with "/". */
  url: string;
  reason: AssistantHitReason | null;
}

export type AssistantChainKind = "work_order" | "definition" | "run" | "files" | "results";

/** One lineage node in a trace answer. */
export interface AssistantChainNode {
  kind: AssistantChainKind;
  id: string;
  label: string;
  url: string | null;
}

/** A validated deep link into a real filtered screen — the payoff frame. */
export interface AssistantDeeplink {
  label: string;
  url: string;
}

export type AssistantFrame =
  /** Human-readable progress line ("thinking"). */
  /* The sessions pipeline emits `text` on its synthetic status frame; the
     mock scripts historically used `message`. Renderers ignore both. */
  | { type: "status"; session_id: string; message?: string; text?: string }
  | { type: "tool_args"; session_id: string; tool_call_id: string; delta: string }
  | { type: "tool_end"; session_id: string; tool_call_id: string }
  /** A tool call started; open a card. */
  | {
      type: "tool_start";
      session_id: string;
      tool_call_id: string;
      tool_name: string;
      display_name: string;
    }
  /** The tool finished; carries a one-line summary for the trace. */
  | {
      type: "tool_result";
      session_id: string;
      tool_call_id: string;
      summary: string;
      is_error: boolean;
    }
  /** A chunk of assistant answer text to append in order. */
  | { type: "answer_delta"; session_id: string; text: string }
  /** Server-hydrated entity cards. */
  | { type: "hits"; session_id: string; hits: AssistantHit[] }
  /** A validated app-relative link (always starts with "/"). */
  | { type: "deeplink"; session_id: string; label: string; url: string }
  /** Lineage nodes for a trace question. */
  | { type: "chain"; session_id: string; nodes: AssistantChainNode[] }
  /** Turn failed. `session_id` is absent when the client synthesises it. */
  | { type: "error"; session_id?: string; message: string }
  /** Turn complete. */
  | { type: "done"; session_id: string };

/** A tool call collected during a turn — feeds the collapsed trace line. */
export interface AssistantTool {
  toolCallId: string;
  /** Display name from `tool_start` (falls back to the raw tool name). */
  name: string;
  /** One-line summary from `tool_result` — null while running. */
  summary: string | null;
  running: boolean;
  isError: boolean;
}

/** One rendered chat message (user prompt or assistant turn). */
export interface AssistantMessage {
  role: "user" | "assistant";
  /** Streamed answer text (the prompt itself for user messages). */
  text: string;
  hits?: AssistantHit[];
  deeplink?: AssistantDeeplink;
  chain?: AssistantChainNode[];
  tools?: AssistantTool[];
  /** The backend session this message belongs to. */
  sessionId?: string;
}
