/**
 * Ask AI ndjson reader (Phase 4).
 *
 * readNdjsonFrames must reassemble lines that straddle chunk boundaries, parse
 * one frame per newline-terminated line, skip malformed lines without aborting,
 * and still emit a trailing frame that has no closing newline.
 */

import { describe, expect, it } from "vitest";
import { readNdjsonFrames, type NdjsonReader } from "@/lib/api/explore-chat";
import type { ExploreChatFrame } from "@/types";

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

describe("readNdjsonFrames", () => {
  it("parses frames and accumulates answer text across a split line", async () => {
    // The second answer_delta line is deliberately split across two chunks.
    const chunks = [
      `{"type":"status","session_id":"s1","message":"Reading…"}\n{"type":"answer_delta","session_id":"s1","text":"Front-left "}\n{"type":"ans`,
      `wer_delta","session_id":"s1","text":"ran hottest."}\n`,
      `{"type":"done","session_id":"s1"}\n`,
    ];

    const frames: ExploreChatFrame[] = [];
    await readNdjsonFrames(readerFromChunks(chunks), (frame) => frames.push(frame));

    expect(frames.map((frame) => frame.type)).toEqual([
      "status",
      "answer_delta",
      "answer_delta",
      "done",
    ]);

    const answer = frames
      .filter((frame): frame is Extract<ExploreChatFrame, { type: "answer_delta" }> => frame.type === "answer_delta")
      .map((frame) => frame.text)
      .join("");
    expect(answer).toBe("Front-left ran hottest.");
  });

  it("skips malformed lines and still emits a trailing frame with no newline", async () => {
    const chunks = [
      `{"type":"status","session_id":"s1","message":"ok"}\n`,
      `{ this is not json }\n`,
      // No trailing newline — the reader must still parse this tail frame.
      `{"type":"done","session_id":"s1"}`,
    ];

    const frames: ExploreChatFrame[] = [];
    await readNdjsonFrames(readerFromChunks(chunks), (frame) => frames.push(frame));

    expect(frames.map((frame) => frame.type)).toEqual(["status", "done"]);
  });
});
