/**
 * Mock result download route (contract §B #18c).
 *
 * It matches the shape of the BE `GET /api/v1/results/{result_id}/download`
 * route in `api/api/routers/results.py`. It exists so `npm run dev` (mock
 * mode) shows the whole download flow honestly, without pretending to serve
 * real parquet bytes.
 *
 * Contract:
 *  - **audit-before-bytes.** `prepareResultDownload` appends the
 *    `result.downloaded` journal entry BEFORE this handler returns a body. If
 *    it throws (unknown id → 404, no storage reference → 409), no entry is
 *    written and no body is served.
 *  - The body is a **deterministic mock payload** whose leading lines name the
 *    result and say the bytes are demo-only.
 *  - `Content-Disposition`, `Content-Length` and `X-Journal-Id` mirror the BE
 *    headers, so the FE code path is the same against either backend. There is
 *    no `X-Checksum-State`: no check ever runs on a result's bytes.
 */

import { getDb, prepareResultDownload } from "@/lib/mock/db";
import { decodeParam, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ resultId: string }> };

function buildMockPayload(name: string, storageRef: string): Uint8Array {
  const header =
    `# MOCK RESULT PAYLOAD — Quix Test Manager (demo, not real bytes)\n` +
    `# result:  ${name}\n` +
    `# stored:  ${storageRef}\n` +
    `# note:    no result artefacts ship in mock mode. Deploy the API against\n` +
    `#          SAG blob storage to receive real bytes.\n` +
    `# ----------------------------------------------------------------------\n`;
  const tail = new Array(64)
    .fill(0)
    .map((_, index) => `mock-row-${String(index).padStart(3, "0")}`)
    .join("\n");
  return new TextEncoder().encode(`${header}${tail}\n`);
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { resultId } = await params;
  return withApi(request, () => {
    // audit-before-bytes: this throws (404/409) or appends the journal entry,
    // and only then does the handler build a body.
    const { result, audit } = prepareResultDownload(getDb(), decodeParam(resultId));
    const payload = buildMockPayload(result.name, result.storage_ref ?? "");
    const body: ArrayBuffer = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${result.name}"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
        "Content-Length": String(body.byteLength),
        "X-Journal-Id": audit.id,
        "Cache-Control": "no-store",
      },
    });
  });
}
