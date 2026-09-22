/**
 * Sample-rate display. One decimal at most, trailing ".0" dropped. The rule:
 * round a real number, never fabricate one, and render non-finite as an
 * em dash.
 */

import { describe, expect, it } from "vitest";
import { formatRate } from "@/lib/format";

describe("formatRate", () => {
  it("rounds a float artefact to one decimal", () => {
    // Seen in real run data: a raw float printed straight out.
    expect(formatRate(49.89996665555185)).toBe("49.9");
  });

  it("keeps a clean whole rate whole", () => {
    expect(formatRate(100)).toBe("100");
    expect(formatRate(50)).toBe("50");
    expect(formatRate(10)).toBe("10");
  });

  it("keeps a genuinely fractional rate fractional", () => {
    // 12.5 Hz must stay 12.5 and must not truncate to 12.
    expect(formatRate(12.5)).toBe("12.5");
  });

  it("renders a non-finite value as an em dash, never a number", () => {
    expect(formatRate(Number.NaN)).toBe("—");
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
