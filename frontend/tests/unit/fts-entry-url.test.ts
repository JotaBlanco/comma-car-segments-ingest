/**
 * The Flight Test Station entry links.
 *
 * The station's whole entry contract is the query string, so these strings are
 * the integration. Two rules matter more than the happy path:
 *
 *   1. no answer ever carries a credential;
 *   2. an over-long pick is dropped WHOLE, never truncated — a cut `signal=`
 *      would open the wrong signal rather than none.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  ftsConfigured,
  ftsFrameUrl,
  ftsOrigin,
  ftsTabUrl,
  MAX_ENTRY_URL_CHARS,
  setFtsConfig,
} from "@/lib/fts";

const BASE = "https://va-flight-test-station.dev.quix.io";
const PARENT = "https://va-test-manager.dev.quix.io";
const RUN = "sn003_20260605T071847258Z";

afterEach(() => {
  setFtsConfig(null, null);
});

describe("setFtsConfig", () => {
  it("an empty url means no station, and the origin goes with it", () => {
    setFtsConfig("", "");
    expect(ftsConfigured()).toBe(false);
    expect(ftsOrigin()).toBeNull();
  });

  it("a url with no origin is configured but never framed", () => {
    setFtsConfig(BASE, "");
    expect(ftsConfigured()).toBe(true);
    expect(ftsOrigin()).toBeNull();
  });

  it("trims what the server answered", () => {
    setFtsConfig(`  ${BASE}  `, `  ${BASE}  `);
    expect(ftsTabUrl(RUN, [])?.url).toBe(`${BASE}?run=${RUN}`);
    expect(ftsOrigin()).toBe(BASE);
  });
});

describe("ftsTabUrl", () => {
  it("answers null with no station configured", () => {
    expect(ftsTabUrl(RUN, ["A"])).toBeNull();
  });

  it("names the run and every picked signal, repeating the key", () => {
    setFtsConfig(BASE, BASE);

    const entry = ftsTabUrl(RUN, ["Alt_Baro", "IAS"]);

    expect(entry).toEqual({
      url: `${BASE}?run=${RUN}&signal=Alt_Baro&signal=IAS`,
      signalsDropped: false,
    });
  });

  it("escapes a name the query would otherwise cut", () => {
    setFtsConfig(BASE, BASE);

    const url = ftsTabUrl(RUN, ["A&B=C"])?.url ?? "";

    expect(url).toContain("signal=A%26B%3DC");
    expect(new URL(url).searchParams.getAll("signal")).toEqual(["A&B=C"]);
  });

  it("carries the run alone when nothing is picked", () => {
    setFtsConfig(BASE, BASE);
    expect(ftsTabUrl(RUN, [])?.url).toBe(`${BASE}?run=${RUN}`);
  });
});

describe("ftsFrameUrl", () => {
  it("adds the embed flag and names this page as the parent", () => {
    setFtsConfig(BASE, BASE);

    const url = ftsFrameUrl(RUN, ["IAS"], PARENT)?.url ?? "";
    const query = new URL(url).searchParams;

    expect(query.get("isIframe")).toBe("true");
    expect(query.get("parentOrigin")).toBe(PARENT);
    expect(query.get("run")).toBe(RUN);
    expect(query.getAll("signal")).toEqual(["IAS"]);
  });
});

describe("the URL length cap", () => {
  /** Enough distinct names to push any link past the cap. */
  const manySignals = Array.from({ length: 200 }, (_, i) => `Signal_Name_Number_${i}`);

  it("drops the whole pick rather than cutting one name", () => {
    setFtsConfig(BASE, BASE);

    const entry = ftsTabUrl(RUN, manySignals);

    expect(entry).toEqual({ url: `${BASE}?run=${RUN}`, signalsDropped: true });
    expect(entry?.url.length).toBeLessThanOrEqual(MAX_ENTRY_URL_CHARS);
  });

  it("says nothing was dropped when the pick is empty and the run is long", () => {
    setFtsConfig(BASE, BASE);

    expect(ftsTabUrl("x".repeat(MAX_ENTRY_URL_CHARS), [])?.signalsDropped).toBe(false);
  });

  it("keeps a pick that fits", () => {
    setFtsConfig(BASE, BASE);

    const entry = ftsTabUrl(RUN, ["Alt_Baro", "IAS", "Pitch"]);

    expect(entry?.signalsDropped).toBe(false);
    expect(entry?.url.length).toBeLessThanOrEqual(MAX_ENTRY_URL_CHARS);
  });

  it("the frame hits the cap before the tab, for the identical pick", () => {
    setFtsConfig(BASE, BASE);
    // A pick sized so the frame's two extra parameters tip it over.
    const room = MAX_ENTRY_URL_CHARS - `${BASE}?run=${RUN}`.length;
    const name = "N".repeat(40);
    const count = Math.floor(room / `&signal=${name}`.length);
    const pick = Array.from({ length: count }, () => name);

    expect(ftsTabUrl(RUN, pick)?.signalsDropped).toBe(false);
    expect(ftsFrameUrl(RUN, pick, PARENT)?.signalsDropped).toBe(true);
  });
});

describe("no answer carries a credential", () => {
  it("neither link holds a token, whatever is picked", () => {
    setFtsConfig(BASE, BASE);

    const links = [
      ftsTabUrl(RUN, ["IAS"])?.url ?? "",
      ftsFrameUrl(RUN, ["IAS"], PARENT)?.url ?? "",
    ];

    for (const link of links) {
      for (const secret of ["token", "secret", "password", "bearer"]) {
        expect(link.toLowerCase()).not.toContain(secret);
      }
    }
  });
});
