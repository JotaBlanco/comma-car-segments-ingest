"use client";

/**
 * Ask AI conversation state (Phase 4).
 *
 * Deliberately NOT react-query — a chat turn is a one-shot ndjson stream, not a
 * cacheable resource. The hook owns the transcript, opens the stream on
 * `send`, folds `answer_delta` frames into the trailing assistant message,
 * tracks tool cards, lifts the SQL out of the query tool's arguments, and
 * captures the session id from the first frame so follow-ups stay in-thread.
 */

import { useCallback, useRef, useState } from "react";
import { streamExploreChat } from "@/lib/api/explore-chat";
import type { ExploreChatFrame, ExploreChatMessage, ExploreChatTool } from "@/types";

/** Pull an SQL string out of a tool's raw JSON args (or a raw SQL payload). */
function extractSql(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && "sql" in parsed) {
      const sql = (parsed as { sql?: unknown }).sql;
      if (typeof sql === "string" && sql.trim().length > 0) return sql;
    }
  } catch {
    // Not JSON — fall through to the bare-SQL check.
  }
  if (/^\s*(select|with)\b/i.test(trimmed)) return trimmed;
  return null;
}

/** Fold one frame into the transcript, mutating only the trailing assistant
    message (always the last element while a turn is streaming). */
function applyFrame(
  messages: ExploreChatMessage[],
  frame: ExploreChatFrame,
  sessionId: string | null,
): ExploreChatMessage[] {
  const index = messages.length - 1;
  if (index < 0) return messages;
  const next = [...messages];
  const message: ExploreChatMessage = { ...next[index] };
  const tools: ExploreChatTool[] = message.tools ? [...message.tools] : [];

  const updateTool = (id: string, fn: (tool: ExploreChatTool) => ExploreChatTool) => {
    const position = tools.findIndex((tool) => tool.toolCallId === id);
    if (position >= 0) tools[position] = fn(tools[position]);
  };

  switch (frame.type) {
    case "answer_delta":
      message.text += frame.text;
      break;
    case "tool_start":
      tools.push({
        toolCallId: frame.tool_call_id,
        name: frame.display_name ?? frame.tool_name,
        meta: null,
        running: true,
        isError: false,
        argsRaw: "",
      });
      break;
    case "tool_args":
      updateTool(frame.tool_call_id, (tool) => {
        const argsRaw = tool.argsRaw + frame.delta;
        const sql = extractSql(argsRaw);
        if (sql !== null) message.sql = sql;
        return { ...tool, argsRaw };
      });
      break;
    case "tool_end":
      break;
    case "tool_result":
      updateTool(frame.tool_call_id, (tool) => ({
        ...tool,
        meta: frame.summary ?? tool.meta,
        running: false,
        isError: Boolean(frame.is_error),
      }));
      if (message.sql === undefined && frame.result !== undefined) {
        const sql = extractSql(frame.result);
        if (sql !== null) message.sql = sql;
      }
      break;
    case "clarify":
      message.text +=
        (message.text.length > 0 ? "\n\n" : "") +
        frame.question +
        (frame.options && frame.options.length > 0
          ? "\n" + frame.options.map((option) => `• ${option}`).join("\n")
          : "");
      break;
    case "status":
    case "ping":
    case "error":
    case "done":
      break;
  }

  message.tools = tools;
  if (sessionId !== null) message.sessionId = sessionId;
  next[index] = message;
  return next;
}

export interface UseExploreChat {
  messages: ExploreChatMessage[];
  send: (text: string) => void;
  streaming: boolean;
  error: string | null;
}

export function useExploreChat(runId: string): UseExploreChat {
  const [messages, setMessages] = useState<ExploreChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (text.length === 0 || streamingRef.current) return;

      streamingRef.current = true;
      setStreaming(true);
      setError(null);
      setMessages((previous) => [
        ...previous,
        { role: "user", text },
        { role: "assistant", text: "", tools: [] },
      ]);

      void (async () => {
        try {
          await streamExploreChat({
            runId,
            message: text,
            sessionId: sessionIdRef.current,
            onFrame: (frame) => {
              if (frame.type !== "ping" && "session_id" in frame && frame.session_id) {
                sessionIdRef.current ??= frame.session_id;
              }
              if (frame.type === "error") {
                setError(frame.message);
                return;
              }
              setMessages((previous) => applyFrame(previous, frame, sessionIdRef.current));
            },
          });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          streamingRef.current = false;
          setStreaming(false);
        }
      })();
    },
    [runId],
  );

  return { messages, send, streaming, error };
}
