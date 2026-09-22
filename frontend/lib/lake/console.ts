/* The lake as QuixLab's Explorer reads it: the seven `/api/lake/*` answers its
   provider (`public/explore/measure-lake.js`) was written against, served from
   this origin over the lake's own catalog and query endpoints. The shapes are
   QuixLab's (`quixlab/server/app.py`, `quixlab/sources/lake.py`): a failure
   travels as an `error` field beside empty data, which is what the provider
   reads, on top of the status. */

import { viewerToken } from "@/app/api/proxy/[...path]/route";
import { getDb, runLakeQuery } from "@/lib/mock/db";
import { MockDbError } from "@/lib/mock/errors";
import { lakeGetJson, lakeTarget, mockIsDeliberate, type LakeTarget } from "./proxy";

/** A refusal or an outage, in the provider's shape and with its status. */
export function consoleError(detail: string, status: number, empty: Record<string, unknown>) {
  return Response.json({ ...empty, error: detail }, { status });
}

/** The guards every console route shares: the mock rig, then the viewer, then the lake. */
export async function withLake(
  request: Request,
  empty: Record<string, unknown>,
  onMock: () => Response,
  onLake: (target: LakeTarget) => Promise<Response>,
): Promise<Response> {
  if (mockIsDeliberate()) return onMock();
  if (viewerToken(request) === null) {
    return consoleError("This endpoint serves a signed-in Test Manager viewer only.", 401, empty);
  }
  const target = lakeTarget();
  if (target instanceof Response) {
    const body = (await target.json()) as { detail?: string };
    return consoleError(body.detail ?? "The lake is not configured.", target.status, empty);
  }
  try {
    return await onLake(target);
  } catch (error) {
    return consoleError(error instanceof Error ? error.message : String(error), 502, empty);
  }
}

/** One catalog GET, or the provider-shaped failure. */
export async function catalogGet(
  target: LakeTarget,
  path: string,
  empty: Record<string, unknown>,
): Promise<{ body: Record<string, unknown> } | Response> {
  const answer = await lakeGetJson(target, path);
  if (answer instanceof Response) {
    const body = (await answer.json()) as { detail?: string };
    return consoleError(body.detail ?? `The lake answered ${answer.status}.`, answer.status, empty);
  }
  const body = answer.body;
  return { body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {} };
}

/* ─────────────────────────── SQL rows ─────────────────────────── */

const QUERY_TIMEOUT_MS = 120_000;
const ERROR_TRAILER = "# ERROR:";
const TRAILER_SCAN_BYTES = 600;

/** RFC 4180, as the lake streams it: quoted fields, doubled inner quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      sawAny = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      if (sawAny || field.length > 0) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      sawAny = false;
    } else {
      field += ch;
      sawAny = true;
    }
  }
  if (sawAny || field.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A CSV cell as JSON: a number when it reads as one, null when empty, else the text. */
export function cellValue(raw: string): number | string | null {
  if (raw === "") return null;
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

export interface Records {
  columns: string[];
  rows: Record<string, number | string | null>[];
}

export function toRecords(columns: readonly string[], rows: readonly (readonly string[])[]): Records {
  return {
    columns: [...columns],
    rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, cellValue(r[i] ?? "")]))),
  };
}

/** Run one SELECT on the lake and read its rows as records. Throws with the lake's words. */
export async function lakeRecords(target: LakeTarget, sql: string): Promise<Records> {
  const url = `${target.base}/query?union_by_name=true`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "text/plain",
        Accept: "text/csv",
      },
      body: sql,
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error("The lake did not answer within 120 s — the query may be too heavy.");
    }
    throw new Error(`Could not reach the lake at ${new URL(url).host}.`);
  }
  const text = await upstream.text();
  if (upstream.status === 401 || upstream.status === 403) throw new Error("The lake refused the token.");
  if (!upstream.ok) throw new Error(text.trim().slice(0, 500) || `The lake answered ${upstream.status}.`);
  const tailStart = Math.max(0, text.length - TRAILER_SCAN_BYTES);
  const at = text.slice(tailStart).lastIndexOf(ERROR_TRAILER);
  if (at !== -1) {
    const trailerAt = tailStart + at;
    const lineStart =
      trailerAt === 0 || text[trailerAt - 1] === "\n" || text[trailerAt - 1] === "\r";
    if (lineStart) {
      throw new Error(text.slice(trailerAt + ERROR_TRAILER.length).trim().slice(0, 500) || "The lake query failed.");
    }
  }
  const parsed = parseCsv(text);
  const [header = [], ...body] = parsed;
  return toRecords(header, body);
}

/** The mock rig's rows, in the same records shape. Throws the mock's refusal. */
export function mockRecords(sql: string): Records {
  try {
    const result = runLakeQuery(getDb(), sql);
    const columns = result.columns.map((c) => (typeof c === "string" ? c : c.name));
    return toRecords(columns, result.rows);
  } catch (error) {
    if (error instanceof MockDbError) throw new Error(error.detail);
    throw error;
  }
}
