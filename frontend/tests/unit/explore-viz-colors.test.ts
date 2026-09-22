/**
 * Explore Visualise — generated series palette (tmGeneratedPalette).
 *
 * The DOM-reading half (tmSeriesColors) hands ≤ 4 series the validated
 * --chart-s1..s4 tokens; past that it delegates to this pure generator, which
 * spaces N hues evenly in OKLCH at a fixed per-theme lightness/chroma. Node
 * environment — no DOM.
 */

import { describe, expect, it } from "vitest";
import { tmGeneratedPalette } from "@/lib/charts/tm-chart-theme";

const HEX = /^#[0-9a-f]{6}$/;

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Rough relative luminance — enough to order light vs dark palettes. */
function luma(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("tmGeneratedPalette", () => {
  it("returns exactly N well-formed colors for any N", () => {
    for (const count of [1, 5, 12, 48, 300]) {
      const palette = tmGeneratedPalette(count, false);
      expect(palette).toHaveLength(count);
      for (const color of palette) expect(color).toMatch(HEX);
    }
  });

  it("keeps every color distinct at realistic series counts", () => {
    for (const dark of [false, true]) {
      for (const count of [5, 8, 16, 32]) {
        const palette = tmGeneratedPalette(count, dark);
        expect(new Set(palette).size).toBe(count);
      }
    }
  });

  it("tunes lightness per theme — dark-surface colors are lighter than light-surface ones", () => {
    const light = tmGeneratedPalette(12, false);
    const dark = tmGeneratedPalette(12, true);
    light.forEach((color, index) => {
      expect(luma(dark[index])).toBeGreaterThan(luma(color));
    });
  });

  it("is deterministic for a given count and theme", () => {
    expect(tmGeneratedPalette(9, false)).toEqual(tmGeneratedPalette(9, false));
    expect(tmGeneratedPalette(9, true)).toEqual(tmGeneratedPalette(9, true));
  });
});
