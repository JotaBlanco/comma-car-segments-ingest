/**
 * Client for the MF4 upload service (mf4-to-blob).
 *
 * This is the ONE cross-origin call in the frontend. Every Test Manager backend call
 * goes through the relative `/api/v1/...` Next.js proxy; the upload service is a
 * separate Quix deployment with its own hostname, so its base URL comes from an
 * environment variable and is never hardcoded.
 *
 * Contract (verified against the deployed service):
 *   GET  {BASE}/config
 *     -> { provider, upload_mode, max_file_bytes, concurrency_hint, topic }
 *   POST {BASE}/upload/direct?filename=<name>&size=<bytes>   body = the raw file
 *     -> { upload_id, status, filename, blob_path, size_bytes, sha256 }
 *
 * `upload_id` is the value that goes into `tc_uploads[].upload_id` on
 * `POST /api/v1/vmodel/runs`.
 */

/** Response of `POST {BASE}/upload/direct`. */
export interface Mf4DirectUploadResult {
  upload_id: string
  status: string
  filename?: string | null
  blob_path?: string | null
  size_bytes?: number | null
  sha256?: string | null
}

/** Shown in the dialog when no base URL is configured, instead of failing on click. */
export const MF4_UPLOAD_UNCONFIGURED_MESSAGE =
  "MF4 upload is not configured. Set MF4_UPLOAD_URL on the frontend deployment " +
  "(or NEXT_PUBLIC_MF4_UPLOAD_URL at build time) to the mf4import service URL."

/**
 * Resolve the upload service base URL.
 *
 * Order: the build-time `NEXT_PUBLIC_MF4_UPLOAD_URL` if it was inlined, otherwise the
 * runtime value served by `/api/mf4-upload-config`. Returns `null` when neither is
 * set - callers must disable the upload control rather than attempt a request.
 */
export async function resolveMf4UploadBase(): Promise<string | null> {
  const inlined = process.env.NEXT_PUBLIC_MF4_UPLOAD_URL
  if (inlined) {
    return inlined.replace(/\/+$/, "")
  }

  try {
    const response = await fetch("/api/mf4-upload-config", { cache: "no-store" })
    if (!response.ok) {
      return null
    }
    const data: { base_url?: string | null } = await response.json()
    return data.base_url ? data.base_url.replace(/\/+$/, "") : null
  } catch {
    // A missing config route is the same situation as an unset variable: no upload.
    return null
  }
}

/**
 * Upload one MF4 file and return the service's record of it.
 *
 * XMLHttpRequest rather than fetch for exactly one reason: fetch has no upload
 * progress event, and an MF4 is large enough that a progress bar is the difference
 * between "working" and "frozen". Same reason and same shape as
 * `filesApi.uploadFile` in lib/api/files.ts.
 *
 * No Authorization header: this is a different service from the Test Manager backend
 * and the Quix token is not valid there.
 */
export function uploadMf4Direct(
  baseUrl: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<Mf4DirectUploadResult> {
  const url =
    `${baseUrl}/upload/direct` +
    `?filename=${encodeURIComponent(file.name)}&size=${file.size}`

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    if (onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          onProgress(Math.round((event.loaded / event.total) * 100))
        }
      })
    }

    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed with status ${xhr.status}: ${xhr.responseText}`))
        return
      }
      try {
        const parsed: Mf4DirectUploadResult = JSON.parse(xhr.responseText)
        if (!parsed.upload_id) {
          reject(new Error("Upload service returned no upload_id"))
          return
        }
        resolve(parsed)
      } catch {
        reject(new Error("Upload service returned a non-JSON response"))
      }
    })

    xhr.addEventListener("error", () => reject(new Error("Upload failed: network error")))
    xhr.addEventListener("abort", () => reject(new Error("Upload was aborted")))

    xhr.open("POST", url)
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream")
    xhr.send(file)
  })
}
