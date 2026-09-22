/**
 * Mock result upload route — `POST /api/v1/results/upload` (contract v1.2,
 * the result-upload box). It exists so mock/e2e mode can walk the whole
 * upload flow: multipart in, a minted `ResultBody` out, with the
 * `X-Checksum-SHA256` and `X-Journal-Id` headers the real route
 * (`api/api/routers/results.py upload_result`) sets. The bytes are read only
 * to be measured and hashed — the mock stores no artefact, and the row's
 * `storage_ref` says where the real server would have put one.
 */

import { getDb, uploadResult } from "@/lib/mock/db";
import { errorResponse, withApi } from "../../_lib/http";

/** Same cap as the real route — a result is a summary artefact, never raw data. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request): Promise<Response> {
  return withApi(request, async () => {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return errorResponse(422, "validation_error", "the request body must be multipart/form-data");
    }
    const file = form.get("file");
    const metadata = form.get("metadata");
    if (!(file instanceof File) || typeof metadata !== "string") {
      return errorResponse(
        422,
        "validation_error",
        "the multipart body needs a `file` part and a `metadata` JSON string",
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return errorResponse(
        413,
        "file_too_large",
        `the file is larger than the ${MAX_UPLOAD_BYTES} byte cap`,
      );
    }
    const bytes = await file.arrayBuffer();
    const { result, audit } = uploadResult(getDb(), metadata, file.name || "result.bin", file.size);
    return Response.json(result, {
      status: 201,
      headers: {
        "X-Checksum-SHA256": await sha256Hex(bytes),
        "X-Journal-Id": audit.id,
      },
    });
  });
}
