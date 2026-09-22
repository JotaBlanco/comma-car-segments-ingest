"use client";

/**
 * The seam to QuixLab.
 *
 * **A configured URL shows the controls. No URL hides them.** The rule is the
 * presence of a real value, not a switch. So no screen promises a feature the
 * product does not hold.
 *
 * **Where the value comes from.** The API owns it. `app/layout.tsx` calls
 * `GET /api/v1/integrations/quixlab-url` on the server through
 * `lib/quixlab-server.ts`, and `QuixLabConfigProvider` hands the answer to the
 * setter below. The API deployment holds the one `TM_QUIXLAB_URL` name, so an
 * operator sets one value in one place. The value reaches this module through
 * a prop and never through `process.env`, so `next build` bakes nothing into
 * the image and one image serves every environment.
 */

let configuredUrl: string | null = null;

/**
 * The Portal page that frames the workspace QuixLab, once something resolved it.
 *
 * **Why a second value.** `TM_QUIXLAB_URL` names the QuixLab host, and that
 * host carries no deployment id: the demo value is
 * `quixlab-cb331d0-...`, where `cb331d0` is the git commit the deployment is
 * pinned to (`Quix.Portal.Frontend .../deployments-create-dialog.component.ts:868`).
 * Only the Portal knows the deployment id, so the API reads it from
 * `GET /workspaces/{id}/deployments` and hands it over as
 * `portal_embedded_url` on every deployment row. This is where that value
 * lands, so a control with no list of its own — the run and file detail
 * headers — can still open the embedded view. The sidebar fetches the list and
 * fills it (`components/shell/sidebar.tsx`).
 *
 * Null means "nothing resolved one", and every tab then opens the direct
 * QuixLab URL exactly as it did before. No frame reads this value: a frame
 * loads `embed_url` and relays the token itself.
 */
let portalEmbeddedUrl: string | null = null;

/**
 * Take the Portal embedded URL of the workspace QuixLab. Empty means none.
 *
 * It is a page address and it carries no credential: a deployment id and a
 * workspace id are not secrets.
 */
export function setQuixLabPortalUrl(url: string | null | undefined): void {
  const trimmed = (url ?? "").trim();
  portalEmbeddedUrl = trimmed.length > 0 ? trimmed : null;
}

/**
 * Take the QuixLab URL the server resolved. An empty value means "no QuixLab".
 *
 * `setPortalApiBase` in `lib/portal/client.ts` works the same way, and for the
 * same reason: this is a plain module and it reads no React state.
 */
export function setQuixLabUrl(url: string | null | undefined): void {
  const trimmed = (url ?? "").trim();
  configuredUrl = trimmed.length > 0 ? trimmed : null;
}

/** True when a QuixLab URL reached this process. Every control reads this. */
export function quixLabConfigured(): boolean {
  return configuredUrl !== null;
}

/**
 * Open QuixLab on the analysis notebook, in a new tab.
 *
 * **It opens the Portal's embedded view, not the raw deployment host.** A
 * caller passes the instance's `portal_embedded_url`; a caller with no list of
 * its own passes nothing and this reads the module value above. The Portal
 * page frames QuixLab, sets `isIframe=true` itself, and copies every extra
 * query parameter of its own URL into the frame, so the deep link below
 * reaches QuixLab unchanged
 * (`Quix.Portal.Frontend .../plugins-detail-page.component.ts:163-168`).
 * With no Portal URL anywhere this opens the direct QuixLab root, which is
 * what it always did.
 *
 * **It opens on the click, with no await in front of it.** A browser blocks a
 * `window.open` that a fetch answer triggers, because the click is over by
 * then. The URL is already resolved when the page renders, so this function
 * needs no call of its own.
 *
 * **The link carries the run id.** QuixLab reads `run` from the query string
 * and records it on that viewer's session, the same session field the framed
 * `TM_IMPORT` message writes. So a tab opens the same run the frame opens.
 * With no run id the link stays exactly as it was.
 *
 * **No token, ever.** QuixLab reads no `?token=` on any route — it
 * authenticates with the `quix_session` cookie
 * (`quixlab/src/quixlab/server/auth.py:53,57`). The resolver route refuses a
 * configured value that carries a query, a fragment or userinfo, so the base
 * below is a bare site root.
 *
 * `noopener` keeps the new tab from reaching back through `window.opener`.
 */
export function openQuixLab(url?: unknown, runId?: unknown): void {
  // Only a real string counts as a picked address: the run and file headers
  // pass `undefined`, and the panel passes the URL its picker resolved.
  // Anything else falls back to the configured value.
  const picked = typeof url === "string" ? url.trim() : "";
  const base = picked.length > 0 ? picked : (portalEmbeddedUrl ?? configuredUrl);
  if (base === null) return;
  // A run id is not a credential, and it is the only value this query gains.
  const run = typeof runId === "string" ? runId.trim() : "";
  window.open(quixLabLink(base, null, run), "_blank", "noopener,noreferrer");
}

/**
 * The one deep link, and the only one that works.
 *
 * QuixLab reads exactly three URL parameters. Two of them pick a node:
 * `open=<nodeId>` and `kind=notebook|file`
 * (`quixlab/src/quixlab/server/static/js/pickers.js:16-24`, called from
 * `boot.js:167`, proven by `quixlab/tests/e2e/notebook-modal.spec.js:31`). The
 * third is `isIframe`, which this product never sends. `analysis` is the node
 * the demo seeds.
 */
export const DEFAULT_NODE_ID = "analysis";

/**
 * The link that opens QuixLab on one node, for one run.
 *
 * `open=<node>&kind=notebook` is the one deep link QuixLab reads, and its
 * notebook modal opens any canvas node by id, so an anomaly's analysis cell
 * (`ai_3`, the id QuixLab tags the snippet with) lands on the cell that found
 * it. A missing node opens the seeded notebook, exactly as `openQuixLab` does.
 *
 * A Portal embedded URL already carries `?workspace=`, and a QuixLab site
 * root carries nothing. The separator follows the base, so both keep every
 * parameter they had. A bare root still gets exactly `?open=...`, unchanged.
 */
export function quixLabLink(base: string, nodeId: string | null, runId: string): string {
  const node = (nodeId ?? "").trim();
  const query = new URLSearchParams();
  query.set("open", node.length > 0 ? node : DEFAULT_NODE_ID);
  query.set("kind", "notebook");
  const run = runId.trim();
  if (run.length > 0) query.set("run", run);
  const start = base.includes("?") ? "&" : "?";
  return `${base}${start}${query.toString()}`;
}

/**
 * Open QuixLab on one node in a new tab: an anomaly's analysis cell, for its run.
 *
 * Same base as `openQuixLab`: a picked address, else the Portal's embedded view
 * of the workspace QuixLab, else the configured root. No token, ever.
 */
export function openQuixLabNode(nodeId: string | null, runId: string, url?: string): void {
  const picked = (url ?? "").trim();
  const base = picked.length > 0 ? picked : (portalEmbeddedUrl ?? configuredUrl);
  if (base === null) return;
  window.open(quixLabLink(base, nodeId, runId), "_blank", "noopener,noreferrer");
}

/**
 * The one query QuixLab reads on an embedded page.
 *
 * The API builds `embed_url` with the same flag (`api/api/quixlab.py`). This
 * copy exists for one caller only: the fallback below, which turns the single
 * configured URL into a row of the same shape. Every listed row uses the
 * `embed_url` the API already built, and no caller composes one.
 */
const EMBED_QUERY = "isIframe=true";

/**
 * The longest signal list QuixLab accepts. It answers 400 for a longer one.
 *
 * Two screens read it: the Signals tab warns a person at the moment they pick
 * too many, and the frame refuses to post a list QuixLab would reject.
 */
export const MAX_QUIXLAB_SIGNALS = 500;

/**
 * One QuixLab a person may pick.
 *
 * The field names are the API's, unchanged, so the row the route sent needs no
 * mapping step. `kind` is the field a person reads before they pick:
 * `"deployment"` is shared and stays up, `"devsession"` belongs to one person
 * and it stops.
 *
 * `origin` is the `targetOrigin` of every message the parent posts, and the
 * value it compares `event.origin` against on every message it receives. It
 * carries no credential, and neither does any other field.
 */
export interface QuixLabInstance {
  id: string;
  name: string;
  kind: string;
  status: string;
  url: string;
  embed_url: string;
  origin: string;
  /**
   * The Portal page that frames this instance, or absent. A TAB opens it, and
   * a frame never does: `embed_url` is what a frame in this app loads.
   *
   * Empty for a dev session, which has no deployment id, and empty when the
   * API could not derive the Portal web host. A caller falls back to `url`.
   */
  portal_embedded_url?: string;
}

/** `"deployment"` and `"devsession"`, spelled as `api/api/quixlab.py` spells them. */
export const KIND_DEPLOYMENT = "deployment";
export const KIND_DEVSESSION = "devsession";

/**
 * The configured QuixLab as one pickable row, or null when there is none.
 *
 * This is the fallback of the dropdown and of `workspaceQuixLab` below. An
 * empty list is an ordinary answer of `GET /integrations/quixlabs`: it means
 * this deployment cannot ask the Portal, or the workspace holds none. The
 * single `TM_QUIXLAB_URL` value still works, so the panel and the `/quixlab`
 * page offer it rather than showing nothing.
 *
 * `status` is empty on purpose. The Portal said nothing about this value, so
 * this module invents no word. A caller treats an empty status as "unknown,
 * and pickable", never as "Running".
 */
export function configuredQuixLab(): QuixLabInstance | null {
  if (configuredUrl === null) return null;
  let origin: string;
  try {
    origin = new URL(configuredUrl).origin;
  } catch {
    // The route already refused anything that is not an absolute http(s) URL.
    // A value this function cannot parse has no safe `targetOrigin`, so it is
    // not offered at all.
    return null;
  }
  return {
    id: "configured",
    name: "QuixLab",
    kind: KIND_DEPLOYMENT,
    status: "",
    url: configuredUrl,
    embed_url: `${configuredUrl}?${EMBED_QUERY}`,
    origin,
  };
}

/**
 * True when a person may open this instance.
 *
 * The Portal's own word decides it, compared in lower case. An **empty** status
 * is the configured fallback, which the Portal never described: unknown stays
 * pickable, because refusing it would hide the one QuixLab the local stack and
 * the demo path have.
 */
export function selectable(item: QuixLabInstance): boolean {
  const status = item.status.trim().toLowerCase();
  return status.length === 0 || status === "running";
}

/**
 * The QuixLab a control with no picker of its own opens: the shared
 * deployment, else the configured value, else none.
 *
 * Never a dev session: it belongs to one person and it stops.
 */
export function workspaceQuixLab(items: readonly QuixLabInstance[]): QuixLabInstance | null {
  const shared = items.find((item) => item.kind === KIND_DEPLOYMENT && selectable(item));
  return shared ?? configuredQuixLab();
}
