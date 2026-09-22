/**
 * The two guards in front of POST /api/lake/query.
 *
 * `quix.yaml` publishes the front end to the internet, and this route forwards
 * SQL to QuixLake with the SERVER-held lake token. So it must know who asked,
 * and it must refuse a second statement — the lake's own read-only guard reads
 * the first word of the text only, so `SELECT 1; CREATE TABLE t(x INT)` walks
 * straight past it.
 *
 * The third fact these tests pin is the older promise: an accepted body still
 * reaches the lake byte for byte.
 *
 * This file lives in tests/unit, so vitest.unit.config.ts picks it up
 * (`tests/unit/ **\/*.test.ts`). Run it with `npm run test:unit`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/lake/query/route";
import { isSingleStatement, stripSqlLiteralsAndComments } from "@/lib/explore/sql-statements";
import { PORTAL_TOKEN_HEADER } from "@/lib/portal/token-store";

const LAKE_URL = "http://lake.example";
const LAKE_TOKEN = "server-held-lake-token";
const VIEWER_TOKEN = "viewer-portal-token";

let fetchMock: ReturnType<typeof vi.fn>;
const saved = { ...process.env };

/** A request the way the Explore workbench sends it, with the viewer's token. */
function signedInRequest(sql: string): Request {
  return new Request("http://tm.example/api/lake/query", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN,
    },
    body: JSON.stringify({ sql }),
  });
}

/** The same request with no credential at all. */
function anonymousRequest(sql: string): Request {
  return new Request("http://tm.example/api/lake/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
}

/** The body this route sent on to the lake. */
function forwardedBody(): string {
  return fetchMock.mock.calls[0][1].body as string;
}

beforeEach(() => {
  // No mock branch: these tests exercise the real lake path.
  delete process.env.TM_USE_MOCK_API;
  delete process.env.TM_TEST_HOOKS;
  process.env.QUIX_LAKE_URL = LAKE_URL;
  process.env.Quix__Sdk__Token = LAKE_TOKEN;
  fetchMock = vi.fn(
    async () =>
      new Response("signal,value\ntemp,1\n", {
        status: 200,
        headers: { "content-type": "text/csv" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe("guard 1 — the caller must carry the viewer's Portal token", () => {
  it("refuses an anonymous call with 401 and never reaches the lake", async () => {
    const response = await POST(anonymousRequest("SELECT 1"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized", errors: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never falls back to a shared token when the caller states none", async () => {
    process.env.TM_API_TOKEN = "shared-tm-token";

    const response = await POST(anonymousRequest("SELECT 1"));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the guard when the browser states the viewer's token", async () => {
    const response = await POST(signedInRequest("SELECT 1"));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the server-held lake token upstream, never the viewer's token", async () => {
    await POST(signedInRequest("SELECT 1"));

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${LAKE_TOKEN}`);
  });
});

describe("guard 2 — one statement at a time", () => {
  it("refuses a second statement with 400 and the one_statement code", async () => {
    const response = await POST(signedInRequest("SELECT 1; CREATE TABLE t(x INT)"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "one_statement",
      detail: "Explore runs one statement at a time.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts the statements before the mock branch, so mock mode refuses too", async () => {
    process.env.TM_USE_MOCK_API = "1";

    const response = await POST(anonymousRequest("SELECT 1; DROP TABLE x"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "one_statement" });
  });

  it.each([
    ["a semicolon inside a string", "SELECT ';'"],
    ["a semicolon inside a line comment", "SELECT 1 -- ; DROP TABLE x"],
    ["a semicolon inside a block comment", "SELECT 1 /* ; */ "],
    ["a trailing semicolon", "SELECT 1;"],
  ])("accepts %s", async (_name, sql) => {
    const response = await POST(signedInRequest(sql));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the accepted body still travels verbatim", () => {
  it.each([
    "SELECT signal, value FROM test_signal_samples WHERE run_id = 'RUN-1' LIMIT 10",
    "SELECT 1;",
    "SELECT ';' AS semi -- trailing note\n",
  ])("forwards %j byte for byte", async (sql) => {
    await POST(signedInRequest(sql));

    expect(forwardedBody()).toBe(sql);
  });
});

describe("stripSqlLiteralsAndComments", () => {
  it("drops a single-quoted string, and keeps the doubled escape inside it", () => {
    expect(stripSqlLiteralsAndComments("SELECT 'a;b''c;d' AS x")).toBe("SELECT  AS x");
  });

  it("drops a double-quoted identifier", () => {
    expect(stripSqlLiteralsAndComments('SELECT "od;d" FROM t')).toBe("SELECT  FROM t");
  });

  it("drops a line comment but keeps the line break", () => {
    expect(stripSqlLiteralsAndComments("SELECT 1 -- ; note\nFROM t")).toBe("SELECT 1 \nFROM t");
  });

  it("drops a block comment", () => {
    expect(stripSqlLiteralsAndComments("SELECT 1 /* ; */ FROM t")).toBe("SELECT 1  FROM t");
  });

  it("drops a dollar-quoted block", () => {
    expect(stripSqlLiteralsAndComments("SELECT $$a;b$$ FROM t")).toBe("SELECT  FROM t");
  });

  it("keeps a parameter placeholder, which is not a dollar quote", () => {
    expect(stripSqlLiteralsAndComments("SELECT $1 FROM t")).toBe("SELECT $1 FROM t");
  });

  it("swallows an unterminated string, so no stray semicolon escapes", () => {
    expect(isSingleStatement("SELECT 'a; DROP TABLE x")).toBe(true);
  });
});

describe("isSingleStatement", () => {
  it.each([
    ["SELECT 1", true],
    ["SELECT 1;", true],
    ["SELECT 1;   \n  ", true],
    ["SELECT ';'", true],
    ["SELECT 1 -- ; DROP TABLE x", true],
    ["SELECT 1 /* ; */ ", true],
    ["SELECT $$;$$", true],
    ["SELECT $tag$;$tag$", true],
    ["SELECT 1; CREATE TABLE t(x INT)", false],
    ["SELECT ';'; DROP TABLE x", false],
    ["SELECT 1 -- note\n; DROP TABLE x", false],
    ["SELECT 1 /* note */; DROP TABLE x", false],
  ])("reads %j as %s", (sql, expected) => {
    expect(isSingleStatement(sql)).toBe(expected);
  });
});
