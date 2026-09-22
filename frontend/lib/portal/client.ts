/**
 * Minimal Quix Portal API client — fetches the current user's profile and
 * organization for the account menu. Endpoint shapes match the Portal
 * frontend's swagger-generated models:
 *   GET /profile               -> { userId, email, firstName, lastName, ... }
 *   GET /organisations/current -> { organisationId, name, ... } (204 possible)
 */

/**
 * The Portal API base URL, handed down from the Next server process.
 *
 * **The platform injects `Quix__Portal__Api` into every deployment, always, as
 * a plain variable** (`plans/reference/QUIX-INJECTED-VARIABLES.md`, which cites
 * `DeploymentService.cs:2173`). That variable reaches the **server** process
 * only. So `app/layout.tsx` reads it, `PortalConfigProvider` calls the setter
 * below, and the browser gets the value as a prop.
 *
 * **This read was `process.env.NEXT_PUBLIC_QUIX_PORTAL_API` until 19 Aug 2026.**
 * `next build` inlines a `NEXT_PUBLIC_` name into the bundle, so one image
 * could serve one environment only. The front end runs a server, so it reads
 * the value at request time and needs no build argument.
 *
 * **There is no default value, and that is the point.** The old default named
 * `https://portal-api.platform.quix.io`. No platform source names that host, so
 * every call went to a host that does not exist and failed slowly and quietly.
 * An absent value now fails loudly, the way `resolveBackend` in the proxy
 * refuses to serve mock data as real.
 */
let configuredBase: string | null = null;

/**
 * Take the base URL the server read. An empty value means "no Portal".
 *
 * The Portal token holder in `token-store.ts` works the same way, and for the
 * same reason: `client.ts` is a plain module and it reads no React state.
 */
export function setPortalApiBase(base: string | null | undefined): void {
  const trimmed = (base ?? "").trim().replace(/\/+$/, "");
  configuredBase = trimmed.length > 0 ? trimmed : null;
}

/** No Portal API base URL reached this process. */
export class PortalNotConfiguredError extends Error {
  constructor() {
    super("Quix__Portal__Api is not set, so this app knows no Portal");
    this.name = "PortalNotConfiguredError";
  }
}

/** Return the Portal API base URL. Throw when nothing configured one. */
export function portalApiBase(): string {
  if (configuredBase === null) throw new PortalNotConfiguredError();
  return configuredBase;
}

/**
 * The origin a Portal token may arrive from, and the origin we ask.
 *
 * The Portal frames this app and posts the token over `postMessage`. A
 * listener that skips `event.origin` takes a token from any page that frames
 * us, so the app needs the Portal origin. It derives that origin from
 * `Quix__Portal__Api`, the one variable `portalApiBase` already reads. A second
 * variable would be a second source of truth, and the two would drift.
 *
 * **The derivation replaces the first label. It does not drop it.** The
 * platform gives every service its own host under one domain. The Portal web
 * app is the `portal` chart, and its ingress host is
 * `{chart}.{environment}.{publicDomain}`
 * (`Quix.Portal.Frontend\\Helm\\portal\\templates\\ingress.yaml:18`). The
 * Angular app builds a service URL as `https://{service}.{domain}`
 * (`...\\src\\app\\shared\\services\\authorized-http-client.service.ts:39`),
 * and `domain` is `dev.quix.io`
 * (`...\\src\\config\\environments\\config.dev.json:15`). So the app and the
 * API are siblings, not parent and child:
 *
 * - `portal-api.dev.quix.io` maps to `portal.dev.quix.io`
 *   (`...\\src\\app\\shared\\services\\auth-cookie.service.ts:11-12` names both
 *   hosts).
 * - `portal-api.cloud.quix.io` maps to `portal.cloud.quix.io`, the production
 *   app (`...\\src\\app\\shared\\constants\\constants.ts:14`).
 *
 * An earlier version dropped the label and returned `dev.quix.io`. No Portal
 * runs there, so the check refused every real token.
 *
 * **The list holds the origin the Portal stated, plus the derived one.** The
 * stated origin comes from the `?portalOrigin=` parameter the Portal stamps on
 * the iframe URL, checked against `TRUSTED_PORTAL_SUFFIX`; the derived one is
 * kept so older Portals that stamp nothing keep working. Three
 * Portal pages post an `AUTH_TOKEN` message, and all three run in the Angular
 * app: the plugin page
 * (`...\\modules\\plugins\\pages\\plugins-detail-page\\plugins-detail-page.component.ts:400`),
 * the Lakehouse page
 * (`...\\modules\\workspace\\lakehouse\\lakehouse-page.component.ts:179`) and
 * the dev-session page
 * (`...\\modules\\workspace\\dev-sessions\\pages\\dev-sessions-details-page\\dev-sessions-details-page.component.ts:409`).
 * The API host sends none. It carries the AI chat iframe, and that app speaks
 * `quixai:*` messages and never frames this app
 * (`Quix.AI\\frontend\\src\\hooks\\useHostConfig.test.tsx`). It also serves
 * file content with `Content-Disposition: inline`
 * (`Quix.Portal.Backend\\Quix.Portal.Api\\Controllers\\LibraryController.cs:223`).
 * So trust in the API origin buys no function and widens the hole.
 *
 * `requestTokenFromParent` posts to the first entry.
 */
/**
 * The domain suffix a Portal may be served under.
 *
 * The `portalOrigin` parameter below arrives on the URL, and whoever frames
 * this app controls the URL. So the parameter is a claim, never a fact: an
 * attacker may frame this app with `?portalOrigin=https://evil.example` and
 * would otherwise be handed a real viewer token. This suffix is what turns
 * the claim into a check. Only `quix.io` hosts (and `localhost` in
 * development) may ever be believed.
 */
const TRUSTED_PORTAL_SUFFIX = ".quix.io";

/** Parses to a bare origin — rejects junk and path smuggling like `https://a.quix.io/../x`. */
function asOrigin(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/**
 * The origin the Portal stated when it framed this app, if it may be trusted.
 *
 * The Portal stamps `?portalOrigin=` on the iframe URL it builds
 * (`Quix.Portal.Frontend\\...\\plugins-detail-page\\plugin-url.utils.ts`). Reading
 * it removes the guesswork the derivation below cannot avoid: it is correct on
 * a preview host, a custom domain and a developer's `localhost`, none of which
 * follow the `portal.<suffix>` rule.
 *
 * The value is checked, not trusted. See `TRUSTED_PORTAL_SUFFIX`.
 */
function statedPortalOrigin(): string | null {
  if (typeof window === "undefined") return null;

  let stated: string | null = null;
  try {
    stated = new URLSearchParams(window.location.search).get("portalOrigin");
  } catch {
    stated = null;
  }
  // No parameter on this URL, so answer the one the first URL stated. See
  // `rememberedOrigin`.
  if (stated === null) return rememberedOrigin;

  rememberedOrigin = trustedOrigin(stated);
  return rememberedOrigin;
}

/**
 * The stated origin this page load already believed.
 *
 * The Portal stamps `?portalOrigin=` on the INITIAL iframe URL only, and the
 * first client-side navigation drops the query string. The read above ran on
 * every call and remembered nothing, so after one navigation the app forgot
 * the origin: a token push then failed the origin check and a handshake posted
 * to the derived guess. That guess is wrong on a preview host, a custom domain
 * and a localhost — the three cases the parameter exists for. So the module
 * holds the answer, the way `takeTokenFromFragment` holds the token it took.
 *
 * A URL that still carries the parameter is read again and takes the same
 * check, so a remembered value never widens the trust.
 */
let rememberedOrigin: string | null = null;

/** The stated value, when it may be believed. See `TRUSTED_PORTAL_SUFFIX`. */
function trustedOrigin(stated: string): string | null {
  const origin = asOrigin(stated);
  if (origin === null) return null;

  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return null;
  }

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    // A local Portal never matches the `portal.<suffix>` rule, so without this
    // the handshake cannot work in development at all. Confined to a
    // development build: a production bundle must never believe localhost.
    return process.env.NODE_ENV === "development" ? origin : null;
  }

  return hostname.endsWith(TRUSTED_PORTAL_SUFFIX) ? origin : null;
}

export function portalOrigins(): readonly string[] {
  // The origin the Portal stated wins: it is the live truth, where the
  // derivation below is only ever an inference from the API hostname.
  const stated = statedPortalOrigin();

  let derived: string | null = null;
  try {
    const url = new URL(portalApiBase());
    const labels = url.hostname.split(".");
    // A base that names no `portal-api` host follows no rule we know. Trust
    // that one host and nothing else. Never widen the list to a guess.
    if (labels.length < 2 || labels[0] !== "portal-api") {
      derived = url.origin;
    } else {
      url.hostname = ["portal", ...labels.slice(1)].join(".");
      derived = url.origin;
    }
  } catch {
    // An absent base and an unparsable base both name no origin. `stated` may
    // still carry one, so this is no longer the end of the road.
    derived = null;
  }

  // The derived origin is KEPT so every deployment that works today keeps
  // working — including a Portal too old to stamp the parameter.
  const origins = [stated, derived].filter((o): o is string => o !== null);
  return [...new Set(origins)];
}

/** Portal responded with a non-2xx status (401 = token invalid/expired). */
export class PortalApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PortalApiError";
  }
}

/** Network-level failure — portal not reachable (offline, CORS, DNS…). */
export class PortalUnreachableError extends Error {
  constructor() {
    super("Quix Portal API is unreachable");
    this.name = "PortalUnreachableError";
  }
}

interface PortalProfileResponse {
  userId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

interface PortalOrganisationResponse {
  organisationId?: string;
  name?: string;
}

export interface PortalUser {
  userId: string;
  email: string;
  displayName: string;
  organizationName: string | null;
}

async function portalGet<T>(path: string, token: string): Promise<T | null> {
  // Read the base OUTSIDE the try. An absent base is a configuration fault and
  // it must say so. Inside the try it would read as "the Portal is offline".
  const base = portalApiBase();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new PortalUnreachableError();
  }
  if (!response.ok) {
    throw new PortalApiError(response.status, `Portal request ${path} failed with ${response.status}`);
  }
  if (response.status === 204) return null;
  return (await response.json()) as T;
}

/**
 * Fetch the signed-in user's profile plus organization display name.
 * The organization lookup is best-effort — a failure there never hides
 * the user profile.
 */
export async function getCurrentUser(token: string): Promise<PortalUser> {
  const profile = await portalGet<PortalProfileResponse>("/profile", token);
  if (profile === null) {
    throw new PortalApiError(204, "Portal returned an empty profile");
  }

  let organizationName: string | null = null;
  try {
    const organization = await portalGet<PortalOrganisationResponse>("/organisations/current", token);
    organizationName = organization?.name ?? null;
  } catch {
    // Org name is decorative — ignore failures.
  }

  const email = profile.email ?? "";
  const displayName =
    [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || email || "Quix user";

  return {
    userId: profile.userId ?? "unknown",
    email,
    displayName,
    organizationName,
  };
}
