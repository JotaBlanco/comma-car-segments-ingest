import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filesApi } from "@/lib/api/files";
import { PORTAL_TOKEN_HEADER, setActivePortalToken } from "@/lib/portal/token-store";

/* The download is the one call that writes an audit row about a person, so it
   must never be the one call that hides the person.

   It sent no header at all, so the proxy fell back to the shared TM_API_TOKEN
   and the journal recorded `file.downloaded … static token holder` for a file
   a named viewer took. Every other call already states the viewer's own Portal
   token (`lib/api/client.ts`).

   The second half of this file pins the checksum claim. `X-Checksum-SHA256`
   carries the digest the file document holds, and every file has one.
   `X-Checksum-State` carries the registry's verdict, and only that word may
   put "verified" on a screen. */

const VIEWER_TOKEN = "viewer-portal-token";

let fetchMock: ReturnType<typeof vi.fn>;

function answer(headers: Record<string, string> = {}): Response {
  return new Response(new Blob(["payload"]), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      'content-disposition': 'attachment; filename="bat_cyc.mf4"',
      ...headers,
    },
  });
}

/** The headers the browser sent to our own proxy. */
function sentHeaders(): Record<string, string> {
  return (fetchMock.mock.calls[0][1].headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => answer());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  setActivePortalToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the download states the viewer's own Portal token", () => {
  it("sends the header when the browser holds a token", async () => {
    setActivePortalToken(VIEWER_TOKEN);

    await filesApi.download("f-1", "bat_cyc.mf4");

    expect(sentHeaders()[PORTAL_TOKEN_HEADER]).toBe(VIEWER_TOKEN);
  });

  it("sends no header when the browser holds none, so the shared token stands", async () => {
    setActivePortalToken(null);

    await filesApi.download("f-1", "bat_cyc.mf4");

    expect(sentHeaders()[PORTAL_TOKEN_HEADER]).toBeUndefined();
  });
});

describe("the download reads the checksum verdict, not only the digest", () => {
  it("reads X-Checksum-State beside X-Checksum-SHA256", async () => {
    fetchMock.mockResolvedValueOnce(
      answer({ "X-Checksum-SHA256": "a".repeat(64), "X-Checksum-State": "unverified" }),
    );

    const result = await filesApi.download("f-1", "bat_cyc.mf4");

    expect(result.checksum).toBe("a".repeat(64));
    expect(result.checksumState).toBe("unverified");
  });

  it("reads null when the answer states no verdict", async () => {
    fetchMock.mockResolvedValueOnce(answer({ "X-Checksum-SHA256": "b".repeat(64) }));

    const result = await filesApi.download("f-1", "bat_cyc.mf4");

    expect(result.checksumState).toBeNull();
  });
});
