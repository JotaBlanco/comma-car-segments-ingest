/**
 * The deep link that opens QuixLab on one node: an anomaly's analysis cell, for its run.
 * No token rides on it, and a base that already carries a query keeps it.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_NODE_ID, quixLabLink } from "@/lib/quixlab";

describe("quixLabLink", () => {
  it("opens the named node in the notebook modal, for the run", () => {
    expect(quixLabLink("https://quixlab.example", "ai_3", "sn002_r")).toBe(
      "https://quixlab.example?open=ai_3&kind=notebook&run=sn002_r",
    );
  });
  it("keeps a Portal embedded URL's own query and falls back to the seeded notebook", () => {
    const portal = "https://portal.example/pipeline/deployments/d1/embedded?workspace=ws";
    expect(quixLabLink(portal, null, "")).toBe(`${portal}&open=${DEFAULT_NODE_ID}&kind=notebook`);
    expect(quixLabLink(portal, "  ", "r")).toBe(`${portal}&open=${DEFAULT_NODE_ID}&kind=notebook&run=r`);
  });
  it("escapes what it is given and carries nothing else", () => {
    const link = quixLabLink("https://q.example", "a b", "r&x=1");
    expect(link).toBe("https://q.example?open=a+b&kind=notebook&run=r%26x%3D1");
    expect(link).not.toMatch(/token/i);
  });
});
