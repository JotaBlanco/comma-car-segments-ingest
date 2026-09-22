/**
 * Unprefixed, unauthenticated readiness probe (API-CONTRACT.md §A).
 *
 * The probe names the backend it resolved. It answered a constant `ok` before,
 * so it passed while the proxy served the built-in mock catalog as real data.
 * A probe that cannot fail proves nothing.
 *
 * It shares the proxy's resolver, so the probe and the data path read the same
 * variables by the same rule and can never disagree. It still opens no socket
 * and still needs no token: it reads the environment only.
 */
import {
  mockIsDeliberate,
  resolveBackend,
  rewriteReachesBackend,
} from "@/app/api/proxy/[...path]/route";

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const backend = resolveBackend(url);

  if (backend === null) {
    // The same fault the proxy refuses, reported one call earlier.
    return Response.json(
      {
        status: "error",
        backend: null,
        detail:
          "no backend is configured — set API_URL to the registry API, or set " +
          "TM_BE_URL so the rewrite reaches it",
      },
      { status: 503 },
    );
  }

  // Our own origin serves the built-in mock when no rewrite carries the call on.
  // A person asked for that with TM_USE_MOCK_API or TM_TEST_HOOKS, so it stays a
  // 200 and the end-to-end rig still boots. The flag says what the numbers are.
  const mock =
    backend === url.origin && !rewriteReachesBackend() && mockIsDeliberate();

  return Response.json({ status: "ok", backend, mock });
}
