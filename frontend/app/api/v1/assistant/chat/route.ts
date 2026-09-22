/**
 * Mock assistant chat route (AS-6 — local dev and test rigs only).
 *
 * Matches the shape of the real backend route `POST /api/v1/assistant/chat`,
 * which streams application/x-ndjson frames (one JSON object per line,
 * discriminated on `type`). This mock replays a deterministic script chosen by
 * keyword — the scripts live in lib/mock/assistant-script.ts so tests import
 * the exact frames this route serves (the stubbed-LLM rule: no CI job calls a
 * live model).
 */

import { scriptForMessage } from "@/lib/mock/assistant-script";
import { readJsonBody, withApi } from "../../_lib/http";

const encoder = new TextEncoder();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request): Promise<Response> {
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    const message = typeof body.message === "string" ? body.message : "";
    const frames = scriptForMessage(message);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          // A small gap between frames gives the panel a real streaming feel.
          await sleep(frame.type === "answer_delta" ? 90 : 60);
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    });
  });
}
