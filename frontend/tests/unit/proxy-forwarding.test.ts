import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "@/app/api/proxy/[...path]/route";

/* The proxy is the one hop every browser call takes, so it must hand on what it
   receives. These tests pin the three things it used to damage:

   1. the request bytes — `request.text()` decoded them as UTF-8 and replaced
      every invalid sequence, which corrupts a parquet file or a workbook;
   2. the response headers — the route kept `Content-Type` alone, so
      `X-Checksum-SHA256`, `X-Journal-Id` and `Content-Disposition` all died;
   3. the verb list — the route exported three verbs, so `DELETE
      /test-runs/{run_id}/invalid-flag` reached nothing.

   The guards stay as they are. The last block proves it. */

const ORIGIN = "http://tm.example";
const BACKEND = "http://tm-api";

const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

/** A request the way the app's own page sends it. */
function browserRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { "sec-fetch-site": "same-origin", ...(init.headers ?? {}) },
  });
}

/** Read a fetch body, whatever form it takes, back into bytes. */
async function bodyBytes(body: unknown): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

/** Hand raw bytes to a Request. `BodyInit` names an ArrayBuffer, not a view. */
function asBody(bytes: Uint8Array): BodyInit {
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * A multipart body with real non-UTF-8 bytes inside.
 *
 * `0xFF` and `0xFE` start no valid UTF-8 sequence, and `0x80` is a continuation
 * byte with nothing in front of it. A UTF-8 decode replaces each one with
 * U+FFFD, and an encode of the result gives different bytes. `PAR1` is the
 * parquet magic, so this is the shape the R-12 upload really sends.
 */
const PARQUET_BYTES = new Uint8Array([
  0x50, 0x41, 0x52, 0x31, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x50, 0x41, 0x52, 0x31,
]);
const BOUNDARY = "----tmBoundary4711";

function multipartBody(): Uint8Array {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="run.parquet"\r\n' +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
  const bytes = new Uint8Array(head.length + PARQUET_BYTES.length + tail.length);
  bytes.set(head, 0);
  bytes.set(PARQUET_BYTES, head.length);
  bytes.set(tail, head.length + PARQUET_BYTES.length);
  return bytes;
}

let fetchMock: ReturnType<typeof vi.fn>;
const saved = { ...process.env };

/** Make the next fetch answer with these headers. */
function backendAnswers(headers: Record<string, string>, status = 200): void {
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ ok: true }), { status, headers }),
  );
}

beforeEach(() => {
  delete process.env.API_URL;
  delete process.env.TM_BE_URL;
  delete process.env.TM_USE_MOCK_API;
  delete process.env.TM_TEST_HOOKS;
  process.env.API_URL = BACKEND;
  process.env.TM_API_TOKEN = "tm-demo-4711";
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe("the proxy hands on the request bytes unchanged", () => {
  it("carries a multipart upload with non-UTF-8 bytes through byte for byte", async () => {
    const sent = multipartBody();

    const response = await POST(
      browserRequest("/api/proxy/results/upload", {
        method: "POST",
        body: asBody(sent),
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      }),
      params(["results", "upload"]),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(await bodyBytes(init.body)).toEqual(sent);
  });

  it("keeps the exact bytes a UTF-8 decode would have replaced", async () => {
    // The control. This is what the old `request.text()` did to the same bytes,
    // and it is why the failure was silent: the server checksummed the damage.
    const decoded = new TextEncoder().encode(new TextDecoder().decode(PARQUET_BYTES));
    expect(decoded).not.toEqual(PARQUET_BYTES);

    await POST(
      browserRequest("/api/proxy/results/upload", {
        method: "POST",
        body: asBody(PARQUET_BYTES),
        headers: { "content-type": "application/octet-stream" },
      }),
      params(["results", "upload"]),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const arrived = await bodyBytes(init.body);
    expect(arrived).toEqual(PARQUET_BYTES);
    expect(arrived).not.toEqual(decoded);
  });

  it("forwards the multipart content type, so the boundary survives", async () => {
    await POST(
      browserRequest("/api/proxy/results/upload", {
        method: "POST",
        body: asBody(multipartBody()),
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      }),
      params(["results", "upload"]),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      `multipart/form-data; boundary=${BOUNDARY}`,
    );
  });

  it("sends no body on a GET", async () => {
    await GET(browserRequest("/api/proxy/home/summary"), params(["home", "summary"]));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeNull();
  });
});

describe("the proxy hands on the response headers", () => {
  it("forwards X-Checksum-SHA256, so the download can say checksum verified", async () => {
    backendAnswers({
      "content-type": "application/octet-stream",
      "X-Checksum-SHA256": "a".repeat(64),
    });

    const response = await GET(
      browserRequest("/api/proxy/files/f-1/download"),
      params(["files", "f-1", "download"]),
    );

    expect(response.headers.get("x-checksum-sha256")).toBe("a".repeat(64));
  });

  it("forwards X-Journal-Id and Content-Disposition from the download", async () => {
    backendAnswers({
      "content-type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="run.parquet"',
      "X-Journal-Id": "je-4711",
      "Cache-Control": "no-store",
    });

    const response = await GET(
      browserRequest("/api/proxy/files/f-1/download"),
      params(["files", "f-1", "download"]),
    );

    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="run.parquet"',
    );
    expect(response.headers.get("x-journal-id")).toBe("je-4711");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("forwards the upload headers on the 201 answer", async () => {
    backendAnswers(
      {
        "content-type": "application/json",
        "X-Checksum-SHA256": "b".repeat(64),
        "X-Journal-Id": "je-8815",
      },
      201,
    );

    const response = await POST(
      browserRequest("/api/proxy/results/upload", {
        method: "POST",
        body: asBody(multipartBody()),
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      }),
      params(["results", "upload"]),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-checksum-sha256")).toBe("b".repeat(64));
    expect(response.headers.get("x-journal-id")).toBe("je-8815");
  });

  it("drops the hop-by-hop headers, which describe the other connection", async () => {
    backendAnswers({
      "content-type": "application/json",
      Connection: "keep-alive",
      "Keep-Alive": "timeout=5",
      "Transfer-Encoding": "chunked",
    });

    const response = await GET(
      browserRequest("/api/proxy/home/summary"),
      params(["home", "summary"]),
    );

    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("keep-alive")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("drops an allow-origin header, so no copy re-opens a cross-site read", async () => {
    // `isOwnPage` records that a cross-site browser call fails because this
    // route sends no allow-origin header. The copy must not cancel that.
    backendAnswers({
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });

    const response = await GET(
      browserRequest("/api/proxy/home/summary"),
      params(["home", "summary"]),
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("names JSON when the backend names no type at all", async () => {
    // Bytes carry no type of their own, so this Response names none either.
    fetchMock.mockImplementation(
      async () => new Response(new TextEncoder().encode("{}"), { status: 200 }),
    );

    const response = await GET(
      browserRequest("/api/proxy/home/summary"),
      params(["home", "summary"]),
    );

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({});
  });
});

describe("the proxy exports the verbs the API serves", () => {
  it("carries DELETE /test-runs/{id}/invalid-flag to the backend", async () => {
    const response = await DELETE(
      browserRequest("/api/proxy/test-runs/run-1/invalid-flag", { method: "DELETE" }),
      params(["test-runs", "run-1", "invalid-flag"]),
    );

    expect(response.status).toBe(200);
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(`${BACKEND}/api/v1/test-runs/run-1/invalid-flag`);
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tm-demo-4711");
  });
});

describe("the two guards still hold on the new paths", () => {
  it("refuses a DELETE with no browser mark, and sends no token", async () => {
    const response = await DELETE(
      new Request(`${ORIGIN}/api/proxy/test-runs/run-1/invalid-flag`, { method: "DELETE" }),
      params(["test-runs", "run-1", "invalid-flag"]),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an upload with no browser mark, and reads no byte of it", async () => {
    const response = await POST(
      new Request(`${ORIGIN}/api/proxy/results/upload`, {
        method: "POST",
        body: asBody(multipartBody()),
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      }),
      params(["results", "upload"]),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still refuses to serve mock data as real on a DELETE", async () => {
    delete process.env.API_URL;

    const response = await DELETE(
      browserRequest("/api/proxy/test-runs/run-1/invalid-flag", { method: "DELETE" }),
      params(["test-runs", "run-1", "invalid-flag"]),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "backend_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
