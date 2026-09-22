/**
 * Ask AI streaming client (Phase 4).
 *
 * POSTs to the Explore chat route through the same server-side proxy the rest
 * of the app uses (BASE_PATH = /api/proxy), reads the application/x-ndjson
 * response body frame-by-frame, and hands each parsed frame to `onFrame`.
 *
 * The viewer's Portal token rides in the `x-portal-token` header; the proxy
 * reads it (viewerToken) and forwards it under the same name, because the API
 * needs the token itself. `api/api/routers/explore_chat.py:90` reads that
 * header and opens the Quix.AI session as the viewer. The Authorization header
 * carries a token too, but `api/api/auth.py` verifies it and keeps only an
 * identity, so it never reaches Quix.AI. This mirrors the
 * lakehouse chat-api.ts reader loop (fetch → body.getReader() → split on "\n"
 * → JSON.parse per line). Uses getActivePortalToken so the in-memory embedded
 * token (postMessage handshake) is sent, not only a stored PAT.
 */

import { getActivePortalToken, PORTAL_TOKEN_HEADER } from "@/lib/portal/token-store";
import type { ExploreChatFrame } from "@/types";

/* The browser client always goes through the proxy, which injects the static
   Authorization header server-side. Kept in step with lib/api/client.ts. */
const BASE_PATH = "/api/proxy";

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
export async function readNdjsonFrames(
  reader: NdjsonReader,
  onFrame: (frame: ExploreChatFrame) => void,
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

function parseFrame(line: string): ExploreChatFrame | null {
  try {
    return JSON.parse(line) as ExploreChatFrame;
  } catch {
    // A partial or malformed line is skipped — never fatal to the stream.
    return null;
  }
}

export interface StreamExploreChatOptions {
  runId: string;
  message: string;
  /** Null/undefined on the first turn; the captured session id afterwards. */
  sessionId?: string | null;
  onFrame: (frame: ExploreChatFrame) => void;
  /** Override the Portal token (defaults to the stored PAT). */
  token?: string | null;
  signal?: AbortSignal;
}

/**
 * Open the chat stream for one turn and pump frames into `onFrame` until the
 * stream ends. A failed request (or a body-less response) surfaces as a single
 * synthesised `error` frame rather than throwing, so callers have one path.
 */
export async function streamExploreChat({
  runId,
  message,
  sessionId,
  onFrame,
  token,
  signal,
}: StreamExploreChatOptions): Promise<void> {
  const portalToken = token ?? getActivePortalToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (portalToken) headers[PORTAL_TOKEN_HEADER] = portalToken;

  let response: Response;
  try {
    response = await fetch(
      `${BASE_PATH}/test-runs/${encodeURIComponent(runId)}/explore/chat`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ message, session_id: sessionId ?? null }),
        signal,
      },
    );
  } catch {
    onFrame({ type: "error", message: "Could not reach the assistant." });
    return;
  }

  if (!response.ok || response.body === null) {
    onFrame({
      type: "error",
      message: `The assistant is unavailable (HTTP ${response.status}).`,
    });
    return;
  }

  await readNdjsonFrames(response.body.getReader(), onFrame);
}
