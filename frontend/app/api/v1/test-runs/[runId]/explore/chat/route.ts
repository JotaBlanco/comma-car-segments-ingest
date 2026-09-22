/**
 * Mock Ask AI chat route (Phase 4 — local dev only).
 *
 * Matches the shape of the real backend route
 * `POST /api/v1/test-runs/{run_id}/explore/chat`, which streams
 * application/x-ndjson frames (one JSON object per line, discriminated on
 * `type`). This mock streams a small, canned sequence — status, tool cards, a
 * streamed answer that references the run's own signals, the query's SQL, and
 * a closing `done` — so the panel is demoable under TM_USE_MOCK_API.
 *
 * The real assistant runs in the Portal; this route never does. It exists only
 * so `npm run dev` can show the flow end to end without a live backend.
 */

import { getDb, listRunSignals } from "@/lib/mock/db";
import type { ExploreChatFrame } from "@/types";
import { decodeParam, readJsonBody, withApi } from "../../../../_lib/http";

type Context = { params: Promise<{ runId: string }> };

const encoder = new TextEncoder();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the canned frame script for a run, referencing its real signal names. */
function buildFrames(runId: string, signalNames: string[]): ExploreChatFrame[] {
  const session_id = `mock-sess-${runId}`;
  const named = signalNames.slice(0, 3);
  const primary = named[0] ?? "the primary signal";
  const secondary = named[1] ?? "a second signal";
  const list = named.length > 0 ? named.join(", ") : "this run's signals";
  const sql =
    `SELECT signal, max(value) AS peak,\n` +
    `       arg_max(timestamp, value) AS peak_at\n` +
    `FROM test_signal_samples\n` +
    (named.length > 0
      ? `WHERE signal IN (${named.map((name) => `'${name}'`).join(", ")})\n`
      : ``) +
    `GROUP BY signal\n` +
    `ORDER BY peak DESC`;

  return [
    { type: "status", session_id, message: "Reading the signal inventory…" },
    {
      type: "tool_start",
      session_id,
      tool_call_id: "t1",
      tool_name: "signal_inventory",
      display_name: "Signal inventory",
    },
    {
      type: "tool_result",
      session_id,
      tool_call_id: "t1",
      summary: `matched ${signalNames.length} signals`,
    },
    {
      type: "tool_start",
      session_id,
      tool_call_id: "t2",
      tool_name: "lakeside_query",
      display_name: "Lakeside query",
    },
    { type: "tool_args", session_id, tool_call_id: "t2", delta: JSON.stringify({ sql }) },
    { type: "tool_end", session_id, tool_call_id: "t2" },
    {
      type: "tool_result",
      session_id,
      tool_call_id: "t2",
      result: sql,
      summary: "scanned this run's Parquet · 0.61 s",
    },
    { type: "answer_delta", session_id, text: `Across ${list}, ` },
    { type: "answer_delta", session_id, text: `${primary} recorded the highest peak, ` },
    { type: "answer_delta", session_id, text: `climbing well above ${secondary} ` },
    { type: "answer_delta", session_id, text: `through the middle of the run. ` },
    { type: "answer_delta", session_id, text: `The query below is scoped to this run only.` },
    { type: "done", session_id },
  ];
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { runId } = await params;
  return withApi(request, async () => {
    // Read (and ignore) the body so an invalid one still 422s like the BE.
    await readJsonBody(request);
    const decodedRunId = decodeParam(runId);
    // listRunSignals 404s (run_not_found) for an unknown run, like the real route.
    const signals = listRunSignals(getDb(), decodedRunId, { page: 1, pageSize: 100 });
    const signalNames = signals.items.map((signal) => signal.name);
    const frames = buildFrames(decodedRunId, signalNames);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          // A small gap between frames gives the panel a real streaming feel.
          await sleep(frame.type === "answer_delta" ? 90 : 160);
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
