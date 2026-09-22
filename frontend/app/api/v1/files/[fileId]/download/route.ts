/**
 * Mock file download route (contract v1.1 §D — file download).
 *
 * This route matches the shape of the BE `GET /api/v1/files/{file_id}/download`
 * route in `api/api/routers/files.py`. It exists so `npm run dev` (mock mode)
 * demonstrates the full download flow honestly, without pretending to serve
 * real MF4 bytes.
 *
 * Contract:
 *  - **audit-before-bytes.** `prepareDownload` appends the `file.downloaded`
 *    journal entry BEFORE this handler returns the response body. If it
 *    throws (unknown id → 404, quarantined → 403), no journal entry is
 *    written and no body is served.
 *  - The response body is a **deterministic mock payload** whose leading
 *    lines name the file, its checksum and the fact that the bytes are
 *    demo-only. Nothing here pretends to be a real MF4 file.
 *  - `Content-Disposition`, `Content-Length`, `X-Checksum-SHA256` and
 *    `X-Journal-Id` mirror the BE headers so the FE code path is the same
 *    against either backend.
 */

import { getDb, prepareDownload } from "@/lib/mock/db";
import { decodeParam, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ fileId: string }> };

function buildMockPayload(filename: string, checksum: string, size: number): Uint8Array {
  const header =
    `# MOCK DOWNLOAD PAYLOAD — Quix Test Manager (demo, not real bytes)\n` +
    `# file:     ${filename}\n` +
    `# checksum: sha256:${checksum}\n` +
    `# size:     ${size} bytes (registry metadata; this mock body is smaller)\n` +
    `# note:     no MF4 samples are shipped in mock mode. Deploy the API against\n` +
    `#           SAG blob storage to receive real bytes. See\n` +
    `#           plans/design/FILE-DOWNLOAD.md \n` +
    `# ------------------------------------------------------------------------\n`;
  // A short, deterministic tail — same length for every call, so a component
  // test can assert the whole response bytes exactly.
  const tail = new Array(256)
    .fill(0)
    .map((_, index) => `mock-line-${String(index).padStart(3, "0")}`)
    .join("\n");
  return new TextEncoder().encode(`${header}${tail}\n`);
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, () => {
    // audit-before-bytes: prepareDownload throws (404/403) or appends the
    // journal entry, and only then do we build the body.
    const { file, audit } = prepareDownload(getDb(), decodeParam(fileId));
    const payload = buildMockPayload(file.filename, file.checksum_sha256, file.size_bytes);
    // Pass through the underlying ArrayBuffer to satisfy BodyInit — some
    // TypeScript lib versions type Uint8Array without the ArrayBuffer overlap.
    const body: ArrayBuffer = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Content-Length": String(body.byteLength),
        "X-Checksum-SHA256": file.checksum_sha256,
        // The real route states the registry's verdict (files.py sends
        // checksum_state or "unverified"); the mock mirrors it so the toast
        // reads the same in both modes. The seeded files carry "verified".
        "X-Checksum-State": file.checksum_state ?? "unverified",
        "X-Journal-Id": audit.id,
        "Cache-Control": "no-store",
      },
    });
  });
}
