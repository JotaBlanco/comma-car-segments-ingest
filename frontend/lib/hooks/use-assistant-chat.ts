"use client";

/**
 * Registry assistant conversation state (AS-5).
 *
 * Deliberately NOT react-query — a chat turn is a one-shot ndjson stream, not
 * a cacheable resource (status IS react-query, see use-assistant-status). The
 * hook owns the transcript, opens the stream on `send`, folds `answer_delta`
 * frames into the trailing assistant message, attaches the server-hydrated
 * `hits` / `deeplink` / `chain` frames to it, tracks tool cards for the trace
 * line, and captures the session id so follow-ups stay in-thread.
 *
 * Adapted from use-explore-chat.ts; this one is registry-wide (no run scope)
 * and carries structured answer frames instead of SQL.
 */

import { useCallback, useRef, useState } from "react";
import { streamAssistantChat } from "@/lib/api/assistant";
import type { AssistantFrame, AssistantMessage, AssistantTool } from "@/types";

/** Fold one frame into the transcript, mutating only the trailing assistant
    message (always the last element while a turn is streaming). */
function applyFrame(
  messages: AssistantMessage[],
  frame: AssistantFrame,
  sessionId: string | null,
): AssistantMessage[] {
  const index = messages.length - 1;
  if (index < 0) return messages;
  const next = [...messages];
  const message: AssistantMessage = { ...next[index] };
  const tools: AssistantTool[] = message.tools ? [...message.tools] : [];

  switch (frame.type) {
    case "answer_delta":
      message.text += frame.text;
      break;
    case "tool_start":
      tools.push({
        toolCallId: frame.tool_call_id,
        name: frame.display_name || frame.tool_name,
        summary: null,
        running: true,
        isError: false,
      });
      break;
    case "tool_result": {
      const position = tools.findIndex((tool) => tool.toolCallId === frame.tool_call_id);
      if (position >= 0) {
        tools[position] = {
          ...tools[position],
          summary: frame.summary ?? null,
          running: false,
          isError: Boolean(frame.is_error),
        };
      }
      break;
    }
    case "hits":
      message.hits = frame.hits;
      break;
    case "deeplink":
      message.deeplink = { label: frame.label, url: frame.url };
      break;
    case "chain":
      message.chain = frame.nodes;
      break;
    case "status":
    case "tool_args":
    case "tool_end":
    case "error":
    case "done":
      break;
  }

  message.tools = tools;
  if (sessionId !== null) message.sessionId = sessionId;
  next[index] = message;
  return next;
}

export interface UseAssistantChat {
  messages: AssistantMessage[];
  send: (text: string) => void;
  streaming: boolean;
  error: string | null;
}

export function useAssistantChat(): UseAssistantChat {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);

  const send = useCallback((raw: string) => {
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
        await streamAssistantChat({
          message: text,
          sessionId: sessionIdRef.current,
          onFrame: (frame) => {
            if ("session_id" in frame && frame.session_id) {
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
  }, []);

  return { messages, send, streaming, error };
}
