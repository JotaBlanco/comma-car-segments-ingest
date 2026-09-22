import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser, PortalApiError, PortalUnreachableError, setPortalApiBase } from "@/lib/portal/client";

/* The account menu names a person, and the journal names a person. The two
   must never disagree because the client invented a name. So a refusal from
   the Portal surfaces, and it never becomes a placeholder. */

const PORTAL_API = "https://portal-api.dev.quix.io";
const TOKEN = "portal-token";

const saved = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

/** Answer /profile and /organisations/current from one map of responses. */
function portalAnswers(byPath: Record<string, Response | (() => Response)>): void {
  fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const answer = byPath[path];
    if (answer === undefined) throw new TypeError("network refused");
    return typeof answer === "function" ? answer() : answer;
  });
  vi.stubGlobal("fetch", fetchMock);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
});

afterEach(() => {
  setPortalApiBase(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe("getCurrentUser maps a Portal profile to a display name", () => {
  it("joins the first name and the last name", async () => {
    portalAnswers({
      "/profile": () =>
        json({
          userId: "u-1",
          email: "emma.lindqvist@volvo.com",
          firstName: "Emma",
          lastName: "Lindqvist",
        }),
      "/organisations/current": () => json({ organisationId: "o-1", name: "Volvo Cars" }),
    });

    const user = await getCurrentUser(TOKEN);

    expect(user).toEqual({
      userId: "u-1",
      email: "emma.lindqvist@volvo.com",
      displayName: "Emma Lindqvist",
      organizationName: "Volvo Cars",
    });
  });

  it("sends the token as a bearer to the configured Portal", async () => {
    portalAnswers({
      "/profile": () => json({ userId: "u-1", firstName: "Emma", lastName: "Lindqvist" }),
      "/organisations/current": () => new Response(null, { status: 204 }),
    });

    await getCurrentUser(TOKEN);

    expect(fetchMock).toHaveBeenCalledWith(`${PORTAL_API}/profile`, {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("uses the email when the profile carries no name", async () => {
    portalAnswers({
      "/profile": () => json({ userId: "u-1", email: "emma.lindqvist@volvo.com" }),
      "/organisations/current": () => new Response(null, { status: 204 }),
    });

    const user = await getCurrentUser(TOKEN);

    expect(user.displayName).toBe("emma.lindqvist@volvo.com");
    expect(user.organizationName).toBeNull();
  });

  it("keeps the profile when the organization lookup fails", async () => {
    portalAnswers({
      "/profile": () => json({ userId: "u-1", firstName: "Emma", lastName: "Lindqvist" }),
      "/organisations/current": () => json({ detail: "boom" }, 500),
    });

    const user = await getCurrentUser(TOKEN);

    expect(user.displayName).toBe("Emma Lindqvist");
    expect(user.organizationName).toBeNull();
  });
});

describe("getCurrentUser surfaces a refusal instead of naming nobody", () => {
  it("throws a 401 rather than falling back to a placeholder name", async () => {
    portalAnswers({
      "/profile": () => json({ detail: "token expired" }, 401),
    });

    // "Quix user" is the last-resort display name at client.ts:92, and
    // api/api/provenance.py rejects that literal as an actor that names
    // nobody. A 401 must therefore raise, never resolve to that string.
    await expect(getCurrentUser(TOKEN)).rejects.toBeInstanceOf(PortalApiError);
    await expect(getCurrentUser(TOKEN)).rejects.toMatchObject({ status: 401 });
  });

  it("throws when the Portal is unreachable", async () => {
    portalAnswers({});

    await expect(getCurrentUser(TOKEN)).rejects.toBeInstanceOf(PortalUnreachableError);
  });

  it("throws when the Portal answers an empty profile", async () => {
    portalAnswers({
      "/profile": () => new Response(null, { status: 204 }),
    });

    await expect(getCurrentUser(TOKEN)).rejects.toBeInstanceOf(PortalApiError);
  });
});
