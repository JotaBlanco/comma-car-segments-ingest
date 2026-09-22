/* The run page's issues: the lake's data snippets over the run's table, narrowed to the
   run. GET ?table=<physical table>&run=<run id>. Without `run`, every snippet of the table:
   the Issues page.

   Forwards `GET {lake}/tables/{table}/snippets` with the lake credential, which never
   reaches the browser (same guards as ../query: a signed-in viewer only, and the lake
   token stays server-side). The narrowing runs here too, so a table with thousands of
   snippets across many runs sends the browser only the run's. */

import { viewerToken } from "@/app/api/proxy/[...path]/route";
import { errorBody, lakeGetJson, lakeTarget, mockIsDeliberate, validTable } from "@/lib/lake/proxy";
import { normaliseSnippet, snippetsForRun } from "@/lib/snippets/anomalies";
import type { DataSnippet } from "@/types";

/* The mock lake: three findings for whatever run asks, so the demo rig and a lone front
   end show the tab working without a lake. Asked for every run, it answers for these two. */
const MOCK_RUNS = ["sn002_20250125T150942051Z", "sn002_20260723T131303942Z"];

function mockSnippets(table: string, run: string): DataSnippet[] {
  const folder = `platform=sn002/work_order=WO-2025-0110/test_definition=TD-ANALOG-DAQ/run_id=${run}/protocol=a429`;
  const at = 1_737_821_514_758;
  const one = (
    id: number,
    bus: string,
    signal: string,
    t0: number,
    t1: number,
    finding: string,
    kind = "anomaly",
    state = "open",
  ): DataSnippet => ({
    id,
    name: `${bus} · ${signal} · ${t0} - ${t1}`,
    sql: `SELECT * FROM ${table} WHERE run_id = '${run}' AND bus = '${bus}' AND signal = '${signal}' AND timestamp BETWEEN ${t0 - 20_000} AND ${t1 + 20_000}`,
    partitions: [folder],
    markdown: `# ${bus} · ${signal}\n\n${finding}\n**Partitions:** bus=${bus} · signal=${signal}\n**Time:** ${t0} - ${t1}\n**Found by:** ai_3 in QuixLab\n**Added:** 2026-09-15T15:58:25Z\n**Kind:** ${kind}\n**State:** ${state}\n`,
    tags: ["quixlab-store", "ai_3_store", "ai_3", kind, state],
    created_at: "2026-09-15T15:58:25Z",
    updated_at: `2026-09-15T15:58:${String(25 + id).padStart(2, "0")}Z`,
  });
  return [
    one(1, "INS1", "inertial_altitude", at, at + 60_000, "**1 anomalous reading(s)** for `inertial_altitude` on bus INS1: an abrupt jump of 663 ft against a mean of 1926 ft."),
    one(2, "INS2", "ground_speed", at + 900_000, at + 955_000, "**55 consecutive samples** of `ground_speed` on bus INS2 frozen at 104.0 kt while INS1 and INS3 kept moving.", "gap", "resolved"),
    one(3, "INS3", "inertial_altitude", at + 1_800_000, at + 1_800_000, "**1 anomalous reading(s)** for `inertial_altitude` on bus INS3 outside 5 sigma.", "outlier", "closed"),
  ];
}

/** The lake's list, each snippet filled to the tab's shape (the lake omits `tags`). */
export function lakeSnippets(body: unknown): DataSnippet[] {
  const list = (body as { snippets?: unknown } | null)?.snippets;
  if (!Array.isArray(list)) return [];
  return list.map(normaliseSnippet).filter((s): s is DataSnippet => s !== null);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const table = url.searchParams.get("table");
  const run = url.searchParams.get("run") ?? "";
  if (!validTable(table)) {
    return Response.json(errorBody("The table query parameter is required.", "invalid_query"), {
      status: 422,
    });
  }
  if (mockIsDeliberate()) {
    const snippets =
      run === ""
        ? MOCK_RUNS.flatMap((r, i) =>
            mockSnippets(table, r).map((s) => ({ ...s, id: s.id + i * 10 })),
          )
        : mockSnippets(table, run);
    return Response.json({ table, run, snippets });
  }
  if (viewerToken(request) === null) {
    return Response.json(
      errorBody("This endpoint serves a signed-in Test Manager viewer only.", "unauthorized"),
      { status: 401 },
    );
  }
  const target = lakeTarget();
  if (target instanceof Response) return target;
  const answer = await lakeGetJson(target, `tables/${encodeURIComponent(table)}/snippets`);
  if (answer instanceof Response) return answer;
  const all = lakeSnippets(answer.body);
  return Response.json({ table, run, snippets: run === "" ? all : snippetsForRun(all, run) });
}
