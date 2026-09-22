/**
 * Registry assistant ndjson reader (AS-5).
 *
 * readAssistantFrames must reassemble lines that straddle chunk boundaries,
 * parse one frame per newline-terminated line, skip malformed lines without
 * aborting, and still emit a trailing frame that has no closing newline.
 * streamAssistantChat must surface every failure — a mid-stream `error`
 * frame, a refused request, a non-OK response — through the same single
 * `onFrame` path, so the hook has one error state to set.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readAssistantFrames,
  streamAssistantChat,
  type NdjsonReader,
} from "@/lib/api/assistant";
import type { AssistantFrame } from "@/types";

/** A fake reader that yields the given string chunks in order, then done. */
function readerFromChunks(chunks: string[]): NdjsonReader {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    read: async () => {
      if (index >= chunks.length) return { done: true };
      return { done: false, value: encoder.encode(chunks[index++]) };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readAssistantFrames", () => {
  it("parses frames and accumulates answer text across a split line", async () => {
    // The second answer_delta line is deliberately split across two chunks.
    const chunks = [
      `{"type":"status","session_id":"s1","message":"thinking"}\n{"type":"answer_delta","session_id":"s1","text":"3 runs "}\n{"type":"ans`,
      `wer_delta","session_id":"s1","text":"were flagged invalid."}\n`,
      `{"type":"done","session_id":"s1"}\n`,
    ];

    const frames: AssistantFrame[] = [];
    await readAssistantFrames(readerFromChunks(chunks), (frame) => frames.push(frame));

    expect(frames.map((frame) => frame.type)).toEqual([
      "status",
      "answer_delta",
      "answer_delta",
      "done",
    ]);

    const answer = frames
      .filter(
        (frame): frame is Extract<AssistantFrame, { type: "answer_delta" }> =>
          frame.type === "answer_delta",
      )
      .map((frame) => frame.text)
      .join("");
    expect(answer).toBe("3 runs were flagged invalid.");
  });

  it("skips malformed lines and still emits a trailing frame with no newline", async () => {
    const chunks = [
      `{"type":"status","session_id":"s1","message":"thinking"}\n`,
      `{ this is not json }\n`,
      // No trailing newline — the reader must still parse this tail frame.
      `{"type":"done","session_id":"s1"}`,
    ];

    const frames: AssistantFrame[] = [];
    await readAssistantFrames(readerFromChunks(chunks), (frame) => frames.push(frame));

    expect(frames.map((frame) => frame.type)).toEqual(["status", "done"]);
  });

  it("delivers a mid-stream error frame like any other frame", async () => {
    const chunks = [
      `{"type":"status","session_id":"s1","message":"thinking"}\n`,
      `{"type":"error","session_id":"s1","message":"budget exhausted"}\n`,
    ];

    const frames: AssistantFrame[] = [];
    await readAssistantFrames(readerFromChunks(chunks), (frame) => frames.push(frame));

    expect(frames[1]).toEqual({
      type: "error",
      session_id: "s1",
      message: "budget exhausted",
    });
  });
});

describe("streamAssistantChat", () => {
  it("synthesises an error frame when the request cannot be made", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );

    const frames: AssistantFrame[] = [];
    await streamAssistantChat({ message: "hi", token: null, onFrame: (f) => frames.push(f) });

    expect(frames).toEqual([{ type: "error", message: "Could not reach the assistant." }]);
  });

  it("maps a 403 (assistant_disabled) to a worded error frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: "assistant_disabled" }, { status: 403 })),
    );

    const frames: AssistantFrame[] = [];
    await streamAssistantChat({ message: "hi", token: null, onFrame: (f) => frames.push(f) });

    expect(frames).toEqual([
      { type: "error", message: "The assistant is not enabled for this deployment." },
    ]);
  });

  it("streams a 200 ndjson body through to onFrame", async () => {
    const body = [
      `{"type":"status","session_id":"s1","message":"thinking"}`,
      `{"type":"answer_delta","session_id":"s1","text":"hello"}`,
      `{"type":"done","session_id":"s1"}`,
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/x-ndjson" },
          }),
      ),
    );

    const frames: AssistantFrame[] = [];
    await streamAssistantChat({ message: "hi", token: null, onFrame: (f) => frames.push(f) });

    expect(frames.map((frame) => frame.type)).toEqual(["status", "answer_delta", "done"]);
  });
});
