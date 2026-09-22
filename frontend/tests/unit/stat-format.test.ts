import { describe, expect, it } from "vitest";
import { formatStat } from "@/components/screens/files/format";
import { formatStat as signalsFormatStat } from "@/components/screens/signals/format";

describe("formatStat", () => {
  it("keeps one decimal and the magnitude for a value of 1 or more", () => {
    expect(formatStat(18.24)).toBe("18.2");
    expect(formatStat(1)).toBe("1.0");
    expect(formatStat(1234.56)).toBe("1234.6");
    expect(formatStat(-47.91)).toBe("-47.9");
  });

  it("keeps two significant digits for a small value, so it never reads 0.0", () => {
    // A lateral acceleration of 0.02 g read "0.0" with one decimal.
    expect(formatStat(0.02)).toBe("0.02");
    expect(formatStat(-0.055)).toBe("-0.055");
    expect(formatStat(0.00043)).toBe("0.00043");
  });

  it("prints a plain zero for zero", () => {
    expect(formatStat(0)).toBe("0.0");
  });

  it("gives the signals screens the same rule as the files screens", () => {
    expect(signalsFormatStat).toBe(formatStat);
  });
});
