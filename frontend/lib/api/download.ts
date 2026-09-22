import { getActivePortalToken, PORTAL_TOKEN_HEADER } from "@/lib/portal/token-store";
import type { ApiErrorBody } from "@/types";
import { ApiError } from "./client";

/**
 * The outcome of a successful byte download.
 *
 * `blob` is the raw payload the browser needs to save (a plain `<a href>`
 * cannot carry an Authorization header, so the app fetches through the same
 * server-side proxy every other call uses and hands the blob to a hidden
 * anchor). **No token ever goes in the URL.**
 *
 * `checksum` is the `X-Checksum-SHA256` header: the digest the registry holds
 * for those bytes. `checksumState` is the `X-Checksum-State` header: the
 * registry's verdict — `verified`, `unverified` or `mismatch`. The two are not
 * the same claim, and only the state may put the word "verified" on a screen.
 * A **result** download carries no state header at all, because no check ever
 * runs on a result's bytes, so `checksumState` reads null there.
 */
export interface DownloadOutcome {
  blob: Blob;
  filename: string;
  checksum: string | null;
  checksumState: string | null;
  journalId: string | null;
  sizeBytes: number;
}

/**
 * Fetch one download route through the proxy and return the bytes.
 *
 * `path` is the API path below `/api/v1`, already encoded — for example
 * `/files/f-1/download`. The file download and the result download both call
 * this, so one token rule, one error rule and one filename rule guard both.
 *
 * The call states the viewer's own Portal token, as `api.get` does. Without it
 * the proxy lends no key of its own on a deployed stack: the platform always
 * injects `Quix__Portal__Api`, so the proxy sends the request with no
 * Authorization header and the API answers 401
 * (`frontend/app/api/proxy/[...path]/route.ts`). The shared token opens the
 * local stack and the mock only, where nobody can sign in and every audit row
 * names the static token holder. A download is the one call that writes an
 * audit row about a person, so it must never be the one call that hides the
 * person.
 */
export async function fetchDownload(
  path: string,
  fallbackFilename: string,
): Promise<DownloadOutcome> {
  const portalToken = getActivePortalToken();
  const response = await fetch(`/api/proxy${path}`, {
    method: "GET",
    cache: "no-store",
    headers: portalToken === null ? {} : { [PORTAL_TOKEN_HEADER]: portalToken },
  });
  if (!response.ok) {
    let errorBody: ApiErrorBody = {
      detail: `Download failed with status ${response.status}`,
      code: "unknown_error",
      errors: [],
    };
    try {
      errorBody = (await response.json()) as ApiErrorBody;
    } catch {
      // Non-JSON error body — keep the fallback detail.
    }
    throw new ApiError(response.status, errorBody.detail, errorBody.code, errorBody.errors);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  return {
    blob,
    filename: parseDispositionFilename(disposition) ?? fallbackFilename,
    checksum: response.headers.get("X-Checksum-SHA256") ?? null,
    checksumState: response.headers.get("X-Checksum-State") ?? null,
    journalId: response.headers.get("X-Journal-Id") ?? null,
    sizeBytes: blob.size,
  };
}

/**
 * Parse the filename from a Content-Disposition header. It accepts both the
 * plain `filename="..."` form and the RFC 5987 `filename*=UTF-8''...` form.
 * It returns `null` when neither is present, so the caller falls back to the
 * filename it already knows.
 */
function parseDispositionFilename(header: string): string | null {
  // Prefer filename*=UTF-8''<pct-encoded> when present — it carries non-ASCII
  // characters intact.
  const extMatch = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extMatch) {
    try {
      return decodeURIComponent(extMatch[1].trim());
    } catch {
      // Fall through to the plain form.
    }
  }
  const plainMatch = /filename="([^"]+)"/i.exec(header);
  return plainMatch ? plainMatch[1] : null;
}

/**
 * Hand a Blob to the browser's own download, without a `<a href>` to the API.
 * `<a>` cannot carry an Authorization header, and the app keeps the API token
 * out of the browser altogether — so the client fetches through the proxy
 * (which adds the header server-side) and hands the blob to a hidden anchor.
 */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Release the blob URL on the next tick — some browsers cancel the download
  // if the URL is revoked synchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
