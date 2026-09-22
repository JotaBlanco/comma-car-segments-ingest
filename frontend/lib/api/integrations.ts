import { api } from "./client";
import { getActivePortalToken } from "@/lib/portal/token-store";
import type { QuixLabInstance } from "@/lib/quixlab";

/** How long this waits for the viewer's Portal token before it asks anyway.

    The embedded handshake times out at three seconds
    (`lib/portal/use-portal-auth.ts:163`), so five is past every honest path. */
const TOKEN_WAIT_MS = 5_000;
const TOKEN_POLL_MS = 150;

/**
 * Resolve once the viewer's Portal token is in the holder, or once we give up.
 *
 * **Why the wait exists.** `usePortalAuth` writes the token one commit after
 * the mount, and embedded it first runs a postMessage handshake of up to three
 * seconds (`lib/portal/use-portal-auth.ts:105-128`). A caller that mounts with
 * the app — the sidebar, and a run detail page a person deep-links to — sends
 * its call before that. The call then carries no `x-portal-token`, the route
 * answers an empty list, and the caller keeps the fallback for the whole
 * session. `components/providers/query-provider.tsx` holds every `useQuery`
 * for the same reason; this is that gate, for the one call that is not a query.
 *
 * It always resolves. A token that never arrives is the signed-out path, and
 * the call then answers the same empty list it answers today.
 */
function portalTokenReady(): Promise<void> {
  if (getActivePortalToken() !== null) return Promise.resolve();
  const giveUpAt = Date.now() + TOKEN_WAIT_MS;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (getActivePortalToken() === null && Date.now() < giveUpAt) return;
      clearInterval(timer);
      resolve();
    }, TOKEN_POLL_MS);
  });
}

/**
 * The QuixLab list, for the picker on the run detail screen.
 *
 * **Whose token.** The viewer's. `lib/api/client.ts` attaches
 * `x-portal-token` from `getActivePortalToken()` on every call, the same way
 * `lib/api/explore-chat.ts` does, and the proxy forwards it. A dev-session
 * list is personal, so the shared bearer would answer the wrong question.
 *
 * **What the caller must keep apart.** An empty `items` is an ordinary answer:
 * this deployment cannot ask the Portal, or the workspace holds none. A
 * **503** `platform_unavailable` is an outage. The first falls back to the
 * configured URL in silence; the second must read as an outage on the screen.
 * This function does not flatten the two — the 503 arrives as an `ApiError`.
 */
/**
 * The Portal's Lakehouse page for this workspace, or an empty string.
 *
 * **The route needs no viewer token. The call still does.** The route derives
 * the value from its own environment and asks the Portal nothing, so the
 * answer costs nothing. But the route sits behind the bearer guard every
 * `/api/v1` route sits behind (`api/api/main.py:563`), and on a deployed front
 * end the proxy lends no shared token: `Quix__Portal__Api` is set, so
 * `sharedTokenIsTheOnlyKey()` is false and a call with no `x-portal-token`
 * goes on with no Authorization header at all
 * (`app/api/proxy/[...path]/route.ts`). The API then answers 401.
 *
 * The sidebar mounts with the app and asks in its first effect, before
 * `usePortalAuth` writes the token. Without this wait that first call is the
 * only call, it is refused, and the Lakehouse item stays hidden for the whole
 * session. `listQuixLabs` below waits for the same reason.
 *
 * Do not remove the wait. An empty string means "show no Lakehouse link", and
 * so does a failed call — which is what a signed-out viewer gets, after
 * `portalTokenReady` gives up.
 */
export async function getLakehouseUrl(): Promise<string> {
  await portalTokenReady();
  const answer = await api.get<{ url?: string }>("/integrations/lakehouse-url");
  return typeof answer.url === "string" ? answer.url.trim() : "";
}

export async function listQuixLabs(): Promise<QuixLabInstance[]> {
  // The route reads the viewer's token, and that token lands after a caller
  // mounts. See `portalTokenReady` above.
  await portalTokenReady();
  const answer = await api.get<{ items?: QuixLabInstance[] }>("/integrations/quixlabs");
  return Array.isArray(answer.items) ? answer.items : [];
}
