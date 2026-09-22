// @vitest-environment jsdom
//
// vitest.unit.config.ts sets the node environment for this folder, and the
// handshake needs a window. The docblock above changes the environment for
// this one file, so the file still matches `tests/unit/**` and still runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portalOrigins, setPortalApiBase } from "@/lib/portal/client";
import { onParentTokenPush, requestTokenFromParent } from "@/lib/portal/token-store";

/* A Portal token is a credential. Any page may frame this app and post a
   well-shaped message, so the shape of a message proves nothing about who
   sent it. Only `event.origin` does. These tests pin that check. */

/* The hosts below come from the Portal source, not from a guess.
   `Quix.Portal.Frontend\src\app\shared\services\auth-cookie.service.ts:11-12`
   names the dev pair. `...\src\app\shared\constants\constants.ts:14` names the
   production app. `...\Helm\portal\templates\ingress.yaml:18` builds the host
   as `{chart}.{environment}.{publicDomain}`, so the app and the API are
   siblings under one domain. */

const PORTAL_API = "https://portal-api.dev.quix.io";
const PORTAL_APP_ORIGIN = "https://portal.dev.quix.io";
const PRODUCTION_PORTAL_API = "https://portal-api.cloud.quix.io";
const PRODUCTION_PORTAL_APP_ORIGIN = "https://portal.cloud.quix.io";
/** The origin the dropped-label bug produced. No Portal runs there. */
const BARE_DOMAIN_ORIGIN = "https://dev.quix.io";
const ATTACKER_ORIGIN = "https://evil.example";

const saved = { ...process.env };

function postFromOrigin(origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin }));
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
});

afterEach(() => {
  setPortalApiBase(null);
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe("portalOrigins derives the Portal origin from the API base", () => {
  it("replaces the portal-api label with portal for the dev host", () => {
    expect(portalOrigins()).toEqual([PORTAL_APP_ORIGIN]);
  });

  it("replaces the portal-api label with portal for the production host", () => {
    setPortalApiBase(PRODUCTION_PORTAL_API);
    expect(portalOrigins()).toEqual([PRODUCTION_PORTAL_APP_ORIGIN]);
  });

  it("never drops the label and names the bare domain", () => {
    // The bug this test guards. `https://dev.quix.io` runs no Portal, so the
    // check refused every real token and the plugin login stopped working.
    expect(portalOrigins()).not.toContain(BARE_DOMAIN_ORIGIN);
    setPortalApiBase(PRODUCTION_PORTAL_API);
    expect(portalOrigins()).not.toContain("https://cloud.quix.io");
  });

  it("names one origin only, and never the API origin", () => {
    // The API host serves file content inline, so a page can live there. It
    // sends no token, so it stays out of the list.
    expect(portalOrigins()).toHaveLength(1);
    expect(portalOrigins()).not.toContain(PORTAL_API);
  });

  it("keeps one origin when the host carries no portal-api label", () => {
    setPortalApiBase("https://quix.example/api");
    expect(portalOrigins()).toEqual(["https://quix.example"]);
  });

  it("names no origin when the base does not parse", () => {
    setPortalApiBase("not a url");
    expect(portalOrigins()).toEqual([]);
  });

  it("never names a wildcard", () => {
    expect(portalOrigins()).not.toContain("*");
  });
});

describe("requestTokenFromParent trusts only the Portal origin", () => {
  it("refuses a token from a wrong origin", async () => {
    const pending = requestTokenFromParent(40);
    postFromOrigin(ATTACKER_ORIGIN, { type: "AUTH_TOKEN", token: "stolen-token" });

    await expect(pending).resolves.toBeNull();
  });

  it("accepts a token from the Portal app origin", async () => {
    const pending = requestTokenFromParent(40);
    postFromOrigin(PORTAL_APP_ORIGIN, { type: "AUTH_TOKEN", token: "real-token" });

    await expect(pending).resolves.toBe("real-token");
  });

  it("accepts a token from the production Portal app origin", async () => {
    setPortalApiBase(PRODUCTION_PORTAL_API);
    const pending = requestTokenFromParent(40);
    postFromOrigin(PRODUCTION_PORTAL_APP_ORIGIN, { type: "AUTH_TOKEN", token: "real-token" });

    await expect(pending).resolves.toBe("real-token");
  });

  it("refuses a token from the bare domain the old derivation named", async () => {
    const pending = requestTokenFromParent(40);
    postFromOrigin(BARE_DOMAIN_ORIGIN, { type: "AUTH_TOKEN", token: "stolen-token" });

    await expect(pending).resolves.toBeNull();
  });

  it("refuses a token from the Portal API origin", async () => {
    const pending = requestTokenFromParent(40);
    postFromOrigin(PORTAL_API, { type: "AUTH_TOKEN", token: "api-host-token" });

    await expect(pending).resolves.toBeNull();
  });

  it("keeps waiting for the Portal after it refuses a wrong origin", async () => {
    const pending = requestTokenFromParent(200);
    postFromOrigin(ATTACKER_ORIGIN, { type: "AUTH_TOKEN", token: "stolen-token" });
    postFromOrigin(PORTAL_APP_ORIGIN, { type: "AUTH_TOKEN", token: "real-token" });

    await expect(pending).resolves.toBe("real-token");
  });

  it("asks the Portal origin and never broadcasts the request to *", async () => {
    const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});

    const pending = requestTokenFromParent(10);

    expect(postMessage).toHaveBeenCalledWith({ type: "REQUEST_AUTH_TOKEN" }, PORTAL_APP_ORIGIN);
    expect(postMessage).not.toHaveBeenCalledWith(expect.anything(), "*");
    await pending;
  });

  it("asks nobody when the configuration names no origin", async () => {
    setPortalApiBase("not a url");
    const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});

    await expect(requestTokenFromParent(10)).resolves.toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("onParentTokenPush trusts only the Portal origin", () => {
  it("refuses a pushed token from a wrong origin", () => {
    const received = vi.fn();
    const unsubscribe = onParentTokenPush(received);

    postFromOrigin(ATTACKER_ORIGIN, { type: "AUTH_TOKEN", token: "stolen-token" });

    expect(received).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("refuses a pushed token from the bare domain the old derivation named", () => {
    const received = vi.fn();
    const unsubscribe = onParentTokenPush(received);

    postFromOrigin(BARE_DOMAIN_ORIGIN, { type: "AUTH_TOKEN", token: "stolen-token" });

    expect(received).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("accepts a pushed token from the Portal app origin", () => {
    const received = vi.fn();
    const unsubscribe = onParentTokenPush(received);

    postFromOrigin(PORTAL_APP_ORIGIN, { type: "AUTH_TOKEN", token: "refreshed-token" });

    expect(received).toHaveBeenCalledWith("refreshed-token");
    unsubscribe();
  });

  it("delivers every token when the Portal refreshes silently", () => {
    // The Portal re-sends a token when it refreshes one. The listener must
    // stay subscribed and report each new token, not only the first.
    const received = vi.fn();
    const unsubscribe = onParentTokenPush(received);

    postFromOrigin(PORTAL_APP_ORIGIN, { type: "AUTH_TOKEN", token: "first-token" });
    postFromOrigin(PORTAL_APP_ORIGIN, { type: "AUTH_TOKEN", token: "refreshed-token" });

    expect(received).toHaveBeenCalledTimes(2);
    expect(received).toHaveBeenLastCalledWith("refreshed-token");
    unsubscribe();
  });

  it("stops after the caller unsubscribes", () => {
    const received = vi.fn();
    onParentTokenPush(received)();

    postFromOrigin(PORTAL_APP_ORIGIN, { type: "AUTH_TOKEN", token: "late-token" });

    expect(received).not.toHaveBeenCalled();
  });

  it("refuses a message of the wrong shape from the Portal origin", () => {
    const received = vi.fn();
    const unsubscribe = onParentTokenPush(received);

    postFromOrigin(PORTAL_APP_ORIGIN, { type: "AUTH_TOKEN", token: "" });
    postFromOrigin(PORTAL_APP_ORIGIN, { type: "SOMETHING_ELSE", token: "t" });
    postFromOrigin(PORTAL_APP_ORIGIN, "a string, not an object");

    expect(received).not.toHaveBeenCalled();
    unsubscribe();
  });
});

/* The Portal stamps `?portalOrigin=` on the iframe URL it builds. Reading it
   removes the guesswork the derivation cannot avoid — it is correct on a
   preview host, a custom domain and a developer's localhost. But it arrives on
   the URL, and whoever frames this app controls the URL, so it is a claim and
   never a fact. These tests pin the check that turns it into one. */
describe("portalOrigins reads the origin the Portal stated", () => {
  function frameWith(search: string): void {
    window.history.replaceState({}, "", `/${search}`);
  }

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("trusts a stated quix.io origin the derivation would never guess", () => {
    // A preview host follows no `portal.<suffix>` rule, so the derivation alone
    // rejected every token it sent. This is the bug the parameter fixes.
    frameWith("?portalOrigin=https%3A%2F%2Fportal-preview-42.quix.io");
    expect(portalOrigins()).toContain("https://portal-preview-42.quix.io");
  });

  it("keeps the derived origin so older Portals keep working", () => {
    // A Portal too old to stamp the parameter must still be believed.
    frameWith("?portalOrigin=https%3A%2F%2Fportal-preview-42.quix.io");
    expect(portalOrigins()).toContain(PORTAL_APP_ORIGIN);
  });

  it("puts the stated origin first, because that is the one we ask", () => {
    frameWith("?portalOrigin=https%3A%2F%2Fportal-preview-42.quix.io");
    expect(portalOrigins()[0]).toBe("https://portal-preview-42.quix.io");
  });

  it("refuses an attacker's origin even though it stated one", () => {
    // The whole point of the suffix check. A page that frames this app and
    // claims to be the Portal must not be handed a viewer's token.
    frameWith(`?portalOrigin=${encodeURIComponent(ATTACKER_ORIGIN)}`);
    expect(portalOrigins()).not.toContain(ATTACKER_ORIGIN);
  });

  it("refuses a lookalike domain that merely ends in the trusted words", () => {
    // `notquix.io` ends with "quix.io" as a string. Suffix checks that forget
    // the leading dot are a classic way to hand a domain to anyone.
    frameWith("?portalOrigin=https%3A%2F%2Fportal.notquix.io");
    expect(portalOrigins()).not.toContain("https://portal.notquix.io");
  });

  it("refuses a value carrying a path, not a bare origin", () => {
    frameWith("?portalOrigin=https%3A%2F%2Fportal.dev.quix.io%2Fevil");
    expect(portalOrigins()).not.toContain("https://portal.dev.quix.io/evil");
  });

  it("refuses junk that names no origin at all", () => {
    frameWith("?portalOrigin=not-a-url");
    expect(portalOrigins()).toEqual([PORTAL_APP_ORIGIN]);
  });

  it("names only the derived origin when the Portal stated nothing", () => {
    expect(portalOrigins()).toEqual([PORTAL_APP_ORIGIN]);
  });

  /* This test stays last in the file: it leaves a stated origin remembered,
     and the two tests above read an empty list. */
  it("keeps the stated origin after a navigation drops the query string", () => {
    // The Portal stamps the parameter on the first iframe URL only. The read
    // remembered nothing, so after one client-side navigation the app fell
    // back to the derived guess: a token push then failed the origin check and
    // the viewer got 401s as soon as the first token expired.
    frameWith("?portalOrigin=https%3A%2F%2Fportal-preview-42.quix.io");
    expect(portalOrigins()[0]).toBe("https://portal-preview-42.quix.io");

    window.history.replaceState({}, "", "/files");

    expect(portalOrigins()[0]).toBe("https://portal-preview-42.quix.io");
  });
});
