// Frontend half of the two-sided contract guard.
//
// It replays the shared golden requests (api/tests/golden_requests.json)
// against the Next.js route handlers in app/api/v1/**. It validates every
// response body against the committed OpenAPI snapshot
// (api/docs/openapi.v1.json). The backend half is
// api/tests/test_contract_snapshot.py. Both halves read the same fixture,
// so the two sides always test the same requests.
//
// The guard checks shape, not values. It cannot catch seed-value drift,
// list order, or environment defaults. See plans/reviews/CONTRACT-CONFORMANCE.md.

import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, test } from "vitest";

// Same test-only token as api/tests/conftest.py. It is not a real secret.
const TEST_TOKEN = "test-token-not-a-secret";
process.env.TM_API_TOKEN = TEST_TOKEN;

const repoRoot = path.resolve(__dirname, "..", "..");

interface GoldenRequest {
  name: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  openapi_path: string;
  /**
   * Query params for the replay. Values may be strings or arrays of strings —
   * the replay harness appends repeated keys per array entry (contract §1.1,
   * mirroring the BE conformance runner which passes list values to httpx).
   */
  query: Record<string, string | string[]> | null;
  body: Record<string, unknown> | null;
  status: number;
}

const golden = JSON.parse(
  readFileSync(path.join(repoRoot, "api", "tests", "golden_requests.json"), "utf8"),
).requests as GoldenRequest[];

const openapi = JSON.parse(
  readFileSync(path.join(repoRoot, "api", "docs", "openapi.v1.json"), "utf8"),
) as { paths: Record<string, unknown> };

const OPENAPI_ID = "openapi.v1.json";
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(openapi as object, OPENAPI_ID);

// One loader per OpenAPI path template. The guard fails loudly when the
// snapshot gains a path with no mock handler here.
const routes: Record<string, () => Promise<Record<string, unknown>>> = {
  "/api/v1/home/summary": () => import("@/app/api/v1/home/summary/route"),
  "/api/v1/test-runs": () => import("@/app/api/v1/test-runs/route"),
  "/api/v1/test-runs/facets": () => import("@/app/api/v1/test-runs/facets/route"),
  "/api/v1/test-runs/groups": () => import("@/app/api/v1/test-runs/groups/route"),
  "/api/v1/test-runs/{run_id}": () => import("@/app/api/v1/test-runs/[runId]/route"),
  "/api/v1/test-runs/{run_id}/invalid-flag": () => import("@/app/api/v1/test-runs/[runId]/invalid-flag/route"),
  "/api/v1/test-runs/{run_id}/files": () => import("@/app/api/v1/test-runs/[runId]/files/route"),
  "/api/v1/test-runs/{run_id}/signals": () => import("@/app/api/v1/test-runs/[runId]/signals/route"),
  "/api/v1/test-runs/{run_id}/journal": () => import("@/app/api/v1/test-runs/[runId]/journal/route"),
  "/api/v1/test-runs/{run_id}/lineage": () => import("@/app/api/v1/test-runs/[runId]/lineage/route"),
  /* /explore/query has no loader on purpose: the mock route was removed with
     the guarded backend path (Explore SQL posts to /api/lake/query, outside
     the v1 contract). A golden entry or snapshot path that still names it
     fails loudly here until api/tests/golden_requests.json and the OpenAPI
     snapshot drop it too. */
  "/api/v1/test-runs/{run_id}/explore/context": () => import("@/app/api/v1/test-runs/[runId]/explore/context/route"),
  "/api/v1/test-runs/{run_id}/explore/chat": () => import("@/app/api/v1/test-runs/[runId]/explore/chat/route"),
  "/api/v1/work-orders": () => import("@/app/api/v1/work-orders/route"),
  "/api/v1/work-orders/facets": () => import("@/app/api/v1/work-orders/facets/route"),
  "/api/v1/test-definitions": () => import("@/app/api/v1/test-definitions/route"),
  "/api/v1/work-orders/{wo_id}": () => import("@/app/api/v1/work-orders/[woId]/route"),
  "/api/v1/files": () => import("@/app/api/v1/files/route"),
  "/api/v1/files/{file_id}": () => import("@/app/api/v1/files/[fileId]/route"),
  "/api/v1/signals": () => import("@/app/api/v1/signals/route"),
  "/api/v1/signals/facets": () => import("@/app/api/v1/signals/facets/route"),
  "/api/v1/signals/{name}": () => import("@/app/api/v1/signals/[name]/route"),
  "/api/v1/signals/{name}/stats": () => import("@/app/api/v1/signals/[name]/stats/route"),
  "/api/v1/results": () => import("@/app/api/v1/results/route"),
  "/api/v1/search": () => import("@/app/api/v1/search/route"),
  "/api/v1/planning-sync/status": () => import("@/app/api/v1/planning-sync/status/route"),
  "/api/v1/assistant/status": () => import("@/app/api/v1/assistant/status/route"),
  "/api/v1/planning-sync/toggle": () => import("@/app/api/v1/planning-sync/toggle/route"),
};

// OpenAPI template params are snake_case; Next.js folder params are camelCase.
function toCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// Match a concrete path against the template. Return the route params.
function extractParams(template: string, concrete: string): Record<string, string> {
  const t = template.split("/");
  const c = concrete.split("/");
  const params: Record<string, string> = {};
  t.forEach((seg, i) => {
    const m = /^\{(.+)\}$/.exec(seg);
    if (m) params[toCamel(m[1])] = c[i];
  });
  return params;
}

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function callRoute(
  method: string,
  concretePath: string,
  template: string,
  query: Record<string, string | string[]> | null,
  body: Record<string, unknown> | null,
  token: string | null = TEST_TOKEN,
): Promise<Response> {
  const load = routes[template];
  expect(load, `no route handler mapped for ${template}`).toBeDefined();
  const mod = await load();
  const handler = mod[method] as Handler | undefined;
  expect(handler, `handler ${method} missing on ${template}`).toBeDefined();

  const url = new URL(`http://tm.test/api/v1${concretePath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    // Array values become repeated query params (contract §1.1).
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, entry);
    } else {
      url.searchParams.set(key, value);
    }
  }
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== null) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const request = new Request(url, init);
  const params = extractParams(template, `/api/v1${concretePath}`);
  return (handler as Handler)(request, { params: Promise.resolve(params) });
}

function validateAgainstSnapshot(template: string, method: string, status: number, payload: unknown): void {
  const pointer =
    `${OPENAPI_ID}#/paths/` +
    template.replace(/~/g, "~0").replace(/\//g, "~1") +
    `/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const validate = ajv.getSchema(pointer);
  expect(validate, `no response schema in the snapshot at ${pointer}`).toBeDefined();
  const valid = validate!(payload);
  const errors = (validate!.errors ?? [])
    .map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`)
    .join("\n");
  expect(valid, `response does not match the snapshot schema:\n${errors}`).toBe(true);
}

async function firstFileId(): Promise<string> {
  const response = await callRoute("GET", "/files", "/api/v1/files", null, null);
  const body = (await response.json()) as { items: { file_id: string }[] };
  return body.items[0].file_id;
}

// Known drift, verified red on 2026-08-17. Each entry names its finding in
// plans/reviews/CONTRACT-CONFORMANCE.md. `test.fails` keeps the suite green
// while the drift stands, and turns red the moment someone fixes either side —
// then delete the entry. Warning: an entry also masks any NEW break on that
// endpoint, so keep this list short and fix the findings.
const KNOWN_DRIFT: Record<string, string> = {
  "07 run signals": "L1: FE seeds unit_source null; snapshot requires the Source enum",
  "13 file detail": "L1: same null unit_source inside the file's signal rows",
  "14 signals list": "L1: same null unit_source on the signals list",
  "24 signals missing unit": "L1: same null unit_source — surfaces here because the missing-unit filter selects rows whose source is also null",
  "28 signals by dtype": "L1: same null unit_source — the FR-DM-111 dtype filter selects the same rows the plain list does",
  "29 signals by source system": "L1: same null unit_source — the FR-DM-111 source filter selects the same rows the plain list does",
};

describe("golden requests against the mock handlers", () => {
  // Sequential on purpose: the mock db persists writes, like the real backend will.
  for (const req of golden) {
    const runner = req.name in KNOWN_DRIFT ? test.fails : test;
    runner(req.name, async () => {
      const concrete =
        req.path === "__FIRST_FILE__" ? `/files/${await firstFileId()}` : req.path;
      const response = await callRoute(req.method, concrete, req.openapi_path, req.query, req.body);
      const payload: unknown = await response.json();
      expect(response.status, JSON.stringify(payload)).toBe(req.status);
      validateAgainstSnapshot(req.openapi_path, req.method, req.status, payload);
    });
  }
});

describe("auth guard", () => {
  test("a request without a token gets 401 unauthorized", async () => {
    const response = await callRoute("GET", "/home/summary", "/api/v1/home/summary", null, null, null);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("unauthorized");
  });
});
