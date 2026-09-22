/**
 * Mock route GET /api/v1/test-definitions (TR-001).
 *
 * The route reads the `orphaned` query param and hands it to the mock db.
 * It shares the auth guard of every other v1 route.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/lib/mock/db";
import type {
  JournalEntry,
  Paginated,
  RequirementsFile,
  TestDefinitionDetail,
  TestDefinitionListResponse,
} from "@/types";

const TEST_TOKEN = "test-token-not-a-secret";
process.env.TM_API_TOKEN = TEST_TOKEN;

async function callRoute(query: string, token: string | null = TEST_TOKEN): Promise<Response> {
  const { GET } = await import("@/app/api/v1/test-definitions/route");
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return GET(new Request(`http://tm.test/api/v1/test-definitions${query}`, { headers }));
}

beforeEach(() => {
  resetDb();
});

describe("GET /api/v1/test-definitions", () => {
  it("returns every mirrored definition when the query states no filter", async () => {
    const response = await callRoute("");
    expect(response.status).toBe(200);
    const body = (await response.json()) as TestDefinitionListResponse;
    expect(body.total).toBe(6);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
  });

  it("returns only the orphans when the query states orphaned=true", async () => {
    const response = await callRoute("?orphaned=true");
    const body = (await response.json()) as TestDefinitionListResponse;
    expect(body.total).toBe(1);
    expect(body.items[0].orphaned).toBe(true);
  });

  it("returns only the linked definitions when the query states orphaned=false", async () => {
    const response = await callRoute("?orphaned=false");
    const body = (await response.json()) as TestDefinitionListResponse;
    expect(body.total).toBe(5);
    expect(body.items.every((d) => !d.orphaned)).toBe(true);
  });

  it("refuses a request that carries no token", async () => {
    const response = await callRoute("", null);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("unauthorized");
  });

  it("refuses an invalid page_size", async () => {
    const response = await callRoute("?page_size=7");
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("validation_error");
  });
});

/**
 * Mock route GET /api/v1/test-definitions/{tdId}/journal (contract §8b).
 *
 * The mirror journals a definition, and no mock route served those entries, so
 * the screen read nothing in mock mode. This route matches its four siblings.
 */
async function callJournal(
  tdId: string,
  query = "",
  token: string | null = TEST_TOKEN,
): Promise<Response> {
  const { GET } = await import("@/app/api/v1/test-definitions/[tdId]/journal/route");
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const url = `http://tm.test/api/v1/test-definitions/${tdId}/journal${query}`;
  return GET(new Request(url, { headers }), { params: Promise.resolve({ tdId }) });
}

describe("GET /api/v1/test-definitions/{tdId}/journal", () => {
  it("serves the mirror entries of the definition, newest first", async () => {
    const response = await callJournal("TD-BAT-114");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Paginated<JournalEntry>;
    expect(body.items.map((e) => e.field)).toEqual([
      "test_definition.planned_runs",
      "test_definition.mirrored",
    ]);
    expect(body.page_size).toBe(50);
    expect(body.items[0].entity_type).toBe("test_definition");
  });

  it("keeps one kind when the query names one", async () => {
    const response = await callJournal("TD-BAT-114", "?kind=event");
    const body = (await response.json()) as Paginated<JournalEntry>;
    expect(body.total).toBe(1);
    expect(body.items[0].kind).toBe("event");
  });

  it("serves an empty page for a definition the mirror never moved", async () => {
    const response = await callJournal("TD-EM-201");
    const body = (await response.json()) as Paginated<JournalEntry>;
    expect(body.total).toBe(0);
  });

  it("answers 404 td_not_found when the id names no definition", async () => {
    const response = await callJournal("TD-NOTHING");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("td_not_found");
  });

  it("refuses a request that carries no token", async () => {
    const response = await callJournal("TD-BAT-114", "", null);
    expect(response.status).toBe(401);
  });
});

/**
 * Mock routes for the requirements documents of one definition.
 *
 * The collection route adds a manual document. The item route removes one, and
 * it refuses a planning document, because the planning system owns that one.
 */
async function callDetail(tdId: string): Promise<Response> {
  const { GET } = await import("@/app/api/v1/test-definitions/[tdId]/route");
  const headers = { authorization: `Bearer ${TEST_TOKEN}` };
  const url = `http://tm.test/api/v1/test-definitions/${tdId}`;
  return GET(new Request(url, { headers }), { params: Promise.resolve({ tdId }) });
}

async function callAddRequirements(tdId: string, body: unknown): Promise<Response> {
  const { POST } = await import(
    "@/app/api/v1/test-definitions/[tdId]/requirements-files/route"
  );
  const url = `http://tm.test/api/v1/test-definitions/${tdId}/requirements-files`;
  const request = new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ tdId }) });
}

async function callRemoveRequirements(tdId: string, name: string): Promise<Response> {
  const { DELETE } = await import(
    "@/app/api/v1/test-definitions/[tdId]/requirements-files/[name]/route"
  );
  const url = `http://tm.test/api/v1/test-definitions/${tdId}/requirements-files/${name}`;
  const request = new Request(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  return DELETE(request, { params: Promise.resolve({ tdId, name }) });
}

async function requirementsOf(tdId: string): Promise<RequirementsFile[]> {
  const body = (await (await callDetail(tdId)).json()) as TestDefinitionDetail;
  return body.requirements_files;
}

describe("the requirements documents of a definition", () => {
  it("serves the documents manual first, then by name", async () => {
    const files = await requirementsOf("TD-BAT-114");
    expect(files.map((f) => f.source)).toEqual(["manual", "planning"]);
    expect(files[0].name).toBe("rig-notes.md");
  });

  it("serves an empty list for a definition that carries none", async () => {
    expect(await requirementsOf("TD-EM-201")).toEqual([]);
  });

  it("adds a manual document and names the actor", async () => {
    const response = await callAddRequirements("TD-EM-201", {
      name: "scope.md",
      content: "# Scope",
    });
    expect(response.status).toBe(201);
    const file = (await response.json()) as RequirementsFile;
    expect(file.source).toBe("manual");
    expect(file.updated_by).not.toBeNull();
    expect((await requirementsOf("TD-EM-201")).map((f) => f.name)).toEqual(["scope.md"]);
  });

  it("refuses a second document under a name the definition already carries", async () => {
    await callAddRequirements("TD-EM-201", { name: "scope.md", content: "# Scope" });
    const response = await callAddRequirements("TD-EM-201", { name: "scope.md", content: "# Two" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("requirements_file_exists");
  });

  it("refuses a document that carries no name", async () => {
    const response = await callAddRequirements("TD-EM-201", { name: "  ", content: "# Scope" });
    expect(response.status).toBe(422);
  });

  it("removes a manual document", async () => {
    const response = await callRemoveRequirements("TD-BAT-114", "rig-notes.md");
    expect(response.status).toBe(204);
    expect((await requirementsOf("TD-BAT-114")).map((f) => f.name)).toEqual([
      "acceptance-criteria.md",
    ]);
  });

  it("refuses to remove a planning document", async () => {
    const response = await callRemoveRequirements("TD-BAT-114", "acceptance-criteria.md");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("requirements_file_not_manual");
    expect(await requirementsOf("TD-BAT-114")).toHaveLength(2);
  });

  it("answers 404 when the name matches no document", async () => {
    const response = await callRemoveRequirements("TD-BAT-114", "nothing.md");
    expect(response.status).toBe(404);
  });

  it("answers 404 td_not_found when the id names no definition", async () => {
    const response = await callAddRequirements("TD-NOTHING", { name: "a.md", content: "b" });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("td_not_found");
  });
});

async function callSetProperties(tdId: string, body: unknown): Promise<Response> {
  const { PATCH } = await import(
    "@/app/api/v1/test-definitions/[tdId]/custom-properties/route"
  );
  const url = `http://tm.test/api/v1/test-definitions/${tdId}/custom-properties`;
  const request = new Request(url, {
    method: "PATCH",
    headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(request, { params: Promise.resolve({ tdId }) });
}

async function propertiesOf(tdId: string): Promise<Record<string, string>> {
  const body = (await (await callDetail(tdId)).json()) as TestDefinitionDetail;
  return body.custom_properties;
}

describe("the custom properties of a definition", () => {
  it("serves the seeded map", async () => {
    expect(await propertiesOf("TD-BAT-114")).toEqual({
      "chamber id": "CH-02",
      fixture: "FX-114-B",
    });
  });

  it("serves an empty map for a definition that carries none", async () => {
    expect(await propertiesOf("TD-EM-201")).toEqual({});
  });

  it("replaces the stored map whole", async () => {
    const response = await callSetProperties("TD-BAT-114", {
      custom_properties: { fixture: "FX-9" },
    });
    expect(response.status).toBe(200);
    expect(await propertiesOf("TD-BAT-114")).toEqual({ fixture: "FX-9" });
  });

  it("clears every property when the map is empty", async () => {
    await callSetProperties("TD-BAT-114", { custom_properties: {} });
    expect(await propertiesOf("TD-BAT-114")).toEqual({});
  });

  it("leaves the requirements documents alone", async () => {
    await callSetProperties("TD-BAT-114", { custom_properties: { fixture: "FX-9" } });
    expect(await requirementsOf("TD-BAT-114")).toHaveLength(2);
  });

  it("journals the write against the definition", async () => {
    await callSetProperties("TD-EM-201", { custom_properties: { rig: "R-9" } });
    const body = (await (await callJournal("TD-EM-201")).json()) as Paginated<JournalEntry>;
    const fields = body.items.map((entry) => entry.field);
    expect(fields).toContain("test_definition.custom_properties");
  });

  it("refuses a map above the count cap", async () => {
    const oversized: Record<string, string> = {};
    for (let index = 0; index < 51; index += 1) oversized[`k${index}`] = "v";
    const response = await callSetProperties("TD-EM-201", { custom_properties: oversized });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("too_many_custom_properties");
  });

  it("refuses a name above the key cap", async () => {
    const response = await callSetProperties("TD-EM-201", {
      custom_properties: { ["k".repeat(65)]: "v" },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("custom_property_key_too_long");
  });

  it("refuses a value above the value cap", async () => {
    const response = await callSetProperties("TD-EM-201", {
      custom_properties: { note: "v".repeat(513) },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe(
      "custom_property_value_too_long",
    );
  });

  it("answers 404 td_not_found when the id names no definition", async () => {
    const response = await callSetProperties("TD-NOTHING", { custom_properties: {} });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("td_not_found");
  });
});
