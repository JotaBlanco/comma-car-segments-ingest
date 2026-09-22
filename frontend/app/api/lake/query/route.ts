/* The direct lake path: the Explore workbench posts SQL here and this
   handler forwards it to QuixLake VERBATIM — byte-identical to the text
   the editor holds. No CTE prepending, no outer wrap, no trimming, no
   semicolon stripping, no rewriting of any kind. The handler exists for
   two reasons only: the lake token must never reach the browser, and the
   lake sets no CORS headers for our origin.

   The editor names the physical lake table directly — there is no logical
   aliasing (that was removed by decision of the product owner). The run
   scope and the LIMIT both live in the SQL text the editor shows.

   The lake interface is the one `api/api/services/lake.py` documents:
   `POST {base}/query?union_by_name=true`, bearer token, SQL as the raw
   text/plain body, CSV answer. The env names and their order are copied
   from that file on purpose — both paths read the same operator
   configuration. `API_AUTH_TOKEN` is deliberately absent: it authenticates
   but carries no identity, so the lake answers 200 with zero rows.

   Two guards stand in front of the forward, because this route hands out the
   lake credential and `quix.yaml` publishes the front end to the internet.

   1. The caller must carry the viewer's Portal token, the same credential
      every other Test Manager route demands. There is NO fallback to a shared
      token here: an anonymous caller is refused, never upgraded.
   2. The body must hold one statement. The lake's read-only guard reads the
      first word only, so `SELECT 1; CREATE TABLE t(x INT)` passes it and
      DuckDB then runs the second statement.

   Neither guard rewrites the query. Guard 2 counts statements on a stripped
   COPY (`lib/explore/sql-statements.ts`); the bytes below still travel
   verbatim. */

// The caller's own credential, read exactly the way the proxy route reads it.
// One function, so the two routes cannot drift apart.
import { viewerToken } from "@/app/api/proxy/[...path]/route";
import { isSingleStatement } from "@/lib/explore/sql-statements";
import { getDb, runLakeQuery } from "@/lib/mock/db";
import { MockDbError } from "@/lib/mock/errors";

const URL_VARS = ["Quix__Lakehouse__Query__Url", "QUIX_LAKE_URL"] as const;
const TOKEN_VARS = ["Quix__Lakehouse__Query__AuthToken", "Quix__Sdk__Token"] as const;

/* The cap protects the browser from an unbounded SELECT; the SQL itself is
   never modified — the editor's LIMIT is the real limit. */
const MAX_ROWS = 10_000;
const TIMEOUT_MS = 120_000;

/* The lake streams a trailing CSV comment when a started query then fails. */
const ERROR_TRAILER = "# ERROR:";
/* How far from the end the trailer scan looks. The trailer is the LAST line
   of the stream, so only the tail is inspected — a data cell that happens to
   contain the string "# ERROR:" mid-file must never fail a good result. The
   window covers the trailer marker plus the 500 chars of detail we keep. */
const TRAILER_SCAN_BYTES = 600;

function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function errorBody(detail: string, code: string): Record<string, unknown> {
  return { detail, code, errors: [] };
}

/* Same gate as the proxy route's mockIsDeliberate(): TM_USE_MOCK_API names
   itself for a developer running the front end alone, TM_TEST_HOOKS marks
   the e2e rig (playwright.config.ts sets it suite-wide). Neither is ever set
   in a deployed image, so the real lake path below stays the only path
   anywhere real. */
function mockIsDeliberate(): boolean {
  return process.env.TM_USE_MOCK_API === "1" || process.env.TM_TEST_HOOKS === "1";
}

/* RFC 4180: fields may be quoted; a quoted field doubles inner quotes and
   may contain commas and line breaks. The lake emits this shape. */
function parseCsv(text: string): string[][] {
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
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
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

export async function POST(request: Request): Promise<Response> {
  let payload: { sql?: unknown };
  try {
    payload = await request.json();
  } catch {
    return Response.json(errorBody("The request body is not JSON.", "invalid_body"), {
      status: 400,
    });
  }
  const sql = typeof payload.sql === "string" ? payload.sql : "";
  if (sql === "") {
    return Response.json(errorBody("The sql field is required.", "invalid_body"), {
      status: 422,
    });
  }

  /* Guard 2 — one statement. This sits with the other body checks, before
     the mock branch, so mock mode and the real lake refuse the same body and
     the e2e rig sees the real verdict. */
  if (!isSingleStatement(sql)) {
    return Response.json(
      errorBody("Explore runs one statement at a time.", "one_statement"),
      { status: 400 },
    );
  }

  // Mock mode answers from the in-memory db (lib/mock/db.ts runLakeQuery),
  // the same store the mock /api/v1 routes read — the e2e rig and a lone
  // front end never reach a real lake.
  if (mockIsDeliberate()) {
    try {
      return Response.json(runLakeQuery(getDb(), sql));
    } catch (error) {
      if (error instanceof MockDbError) {
        return Response.json(errorBody(error.detail, error.code), { status: error.status });
      }
      throw error;
    }
  }

  /* Guard 1 — the caller must authenticate.

     The check stands AFTER the mock branch on purpose. It protects the lake
     credential, and the mock branch holds no credential: it answers from the
     in-memory seed store and reaches no network. `mockIsDeliberate` reads two
     variables that no deployed image sets, so every real request passes here.
     The e2e rig keeps running without a Portal token, and the real path keeps
     its full strength.

     The proxy route falls back to the shared TM_API_TOKEN when the caller is
     anonymous. That fallback is NOT copied here. A caller with no credential
     is refused. */
  if (viewerToken(request) === null) {
    return Response.json(
      errorBody("This endpoint serves a signed-in Test Manager viewer only.", "unauthorized"),
      { status: 401 },
    );
  }

  const base = firstEnv(URL_VARS);
  if (base === undefined) {
    return Response.json(
      errorBody(`The lake is not configured. Set ${URL_VARS[0]}.`, "lake_unavailable"),
      { status: 503 },
    );
  }
  const token = firstEnv(TOKEN_VARS);
  if (token === undefined) {
    return Response.json(
      errorBody(`The lake token is not configured. Set ${TOKEN_VARS[0]}.`, "lake_unavailable"),
      { status: 503 },
    );
  }

  const target = `${base.replace(/\/+$/, "")}/query?union_by_name=true`;
  const started = performance.now();
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
        Accept: "text/csv",
      },
      /* Verbatim: the exact string the editor holds, byte for byte. */
      body: sql,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    // The 120 s budget expiring is not "could not reach": the lake answered
    // the TCP dial and is still chewing. Node reports the expiry as an
    // AbortError/TimeoutError DOMException, so it splits cleanly from a
    // refused/unreachable host and gets its own truthful message.
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return Response.json(
        errorBody(
          "The lake did not answer within 120 s — the query may be too heavy.",
          "lake_timeout",
        ),
        { status: 504 },
      );
    }
    return Response.json(
      errorBody(`Could not reach the lake at ${new URL(target).host}.`, "lake_unavailable"),
      { status: 503 },
    );
  }

  const text = await upstream.text();
  if (upstream.status === 401 || upstream.status === 403) {
    return Response.json(errorBody("The lake refused the token.", "lake_refused"), {
      status: 502,
    });
  }
  if (!upstream.ok) {
    const detail = text.trim().slice(0, 500) || `The lake answered ${upstream.status}.`;
    return Response.json(errorBody(detail, "lake_query_error"), { status: 400 });
  }

  /* Tail-only, and line-anchored: the whole-text indexOf this replaces
     false-positived on a data cell containing "# ERROR:" anywhere in a big
     CSV. A real trailer starts a line at the very end of the stream. */
  const tailStart = Math.max(0, text.length - TRAILER_SCAN_BYTES);
  const trailerInTail = text.slice(tailStart).lastIndexOf(ERROR_TRAILER);
  if (trailerInTail !== -1) {
    const trailerAt = tailStart + trailerInTail;
    const lineStart = trailerAt === 0 || text[trailerAt - 1] === "\n" || text[trailerAt - 1] === "\r";
    if (lineStart) {
      const detail = text.slice(trailerAt + ERROR_TRAILER.length).trim().slice(0, 500);
      return Response.json(errorBody(detail || "The lake query failed.", "lake_query_error"), {
        status: 400,
      });
    }
  }

  const parsed = parseCsv(text);
  const header = parsed[0] ?? [];
  const dataRows = parsed.slice(1);
  /* The cap protects the browser from an unbounded SELECT; the SQL itself
     is never modified — the editor's LIMIT is the real limit. */
  const truncated = dataRows.length > MAX_ROWS;
  const rows = truncated ? dataRows.slice(0, MAX_ROWS) : dataRows;

  return Response.json({
    columns: header.map((name) => ({ name })),
    rows,
    row_count: rows.length,
    truncated,
    elapsed_ms: Math.round(performance.now() - started),
  });
}
