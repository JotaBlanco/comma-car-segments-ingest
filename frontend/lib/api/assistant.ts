/**
 * Registry assistant client (AS-5).
 *
 * Status is a plain JSON GET through the shared client. Chat POSTs to the
 * assistant route through the same server-side proxy the rest of the app uses
 * (BASE_PATH = /api/proxy), reads the application/x-ndjson response body
 * frame-by-frame, and hands each parsed frame to `onFrame`. The reader loop is
 * adapted from lib/api/explore-chat.ts (fetch → body.getReader() → split on
 * "\n" → JSON.parse per line, tolerating a trailing partial line).
 */

import { getActivePortalToken, getStoredToken, PORTAL_TOKEN_HEADER } from "@/lib/portal/token-store";
import type { AssistantFrame, AssistantStatus } from "@/types";
import { api } from "./client";

/* Kept in step with lib/api/client.ts — the proxy injects the static
   Authorization header server-side; the token never reaches the browser. */
const BASE_PATH = "/api/proxy";

export function getAssistantStatus(): Promise<AssistantStatus> {
  return api.get<AssistantStatus>("/assistant/status");
}

/** A minimal reader shape — a real ReadableStream reader satisfies it, and so
    can a hand-rolled fake in tests. */
export interface NdjsonReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/**
 * Drain an ndjson reader: decode chunks, split on newlines (lines may straddle
 * chunk boundaries), and emit one parsed frame per non-empty line. Malformed
 * lines are skipped rather than aborting the stream. Returns when the reader
 * signals `done`.
 */
export async function readAssistantFrames(
  reader: NdjsonReader,
  onFrame: (frame: AssistantFrame) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      const frame = parseFrame(line);
      if (frame !== null) onFrame(frame);
    }
  }
  // A trailing frame with no closing newline still counts.
  const tail = buffer.trim();
  if (tail.length > 0) {
    const frame = parseFrame(tail);
    if (frame !== null) onFrame(frame);
  }
}

function parseFrame(line: string): AssistantFrame | null {
  try {
    return JSON.parse(line) as AssistantFrame;
  } catch {
    // A partial or malformed line is skipped — never fatal to the stream.
    return null;
  }
}

export interface StreamAssistantChatOptions {
  message: string;
  /** Null/undefined on the first turn; the captured session id afterwards. */
  sessionId?: string | null;
  onFrame: (frame: AssistantFrame) => void;
  /** Override the Portal token (defaults to the stored PAT). */
  token?: string | null;
  signal?: AbortSignal;
}

/**
 * Open the chat stream for one turn and pump frames into `onFrame` until the
 * stream ends. A failed request (or a body-less response) surfaces as a single
 * synthesised `error` frame rather than throwing, so callers have one path.
 * A 403 means the assistant is off-platform (no Portal) — worded for the reader.
 */
export async function streamAssistantChat({
  message,
  sessionId,
  onFrame,
  token,
  signal,
}: StreamAssistantChatOptions): Promise<void> {
  // Active (handshake, in-memory) first, stored (standalone PAT) as the
  // fallback — the same order the Explore chat uses. Inside the Portal's
  // iframe localStorage is restricted, so the handshake token lives only in
  // memory; reading storage alone left the sidebar tokenless (ai_unavailable)
  // while Explore worked.
  const portalToken = token ?? getActivePortalToken() ?? getStoredToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (portalToken) headers[PORTAL_TOKEN_HEADER] = portalToken;

  let response: Response;
  try {
    response = await fetch(`${BASE_PATH}/assistant/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, session_id: sessionId ?? null }),
      signal,
    });
  } catch {
    onFrame({ type: "error", message: "Could not reach the assistant." });
    return;
  }

  if (!response.ok || response.body === null) {
    // The API answers 403 for two different situations
    // (api/api/routers/assistant.py): `assistant_disabled` — no agent is
    // configured on this deployment — and `ai_unavailable` — the deployment
    // is fine but the viewer's Portal token is missing or stale. One message
    // for both sent people asking an admin to "enable the assistant" when a
    // fresh sign-in was the whole fix, so the body's code splits them here.
    let code: string | null = null;
    try {
      code = ((await response.json()) as { code?: string }).code ?? null;
    } catch {
      // A body-less or non-JSON error keeps the status-derived message.
    }
    onFrame({
      type: "error",
      message:
        code === "ai_unavailable"
          ? "Your Portal sign-in has expired — sign in again and retry."
          : code === "assistant_disabled" || response.status === 403
            ? "The assistant is not enabled for this deployment."
            : `The assistant is unavailable (HTTP ${response.status}).`,
    });
    return;
  }

  await readAssistantFrames(response.body.getReader(), onFrame);
}
