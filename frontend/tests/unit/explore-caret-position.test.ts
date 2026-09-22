/**
 * mirrorParts — the pure half of the caret mirror-div technique. jsdom (let
 * alone node) does no real layout, so these tests pin the STRING mechanics:
 * what text precedes the marker and what character the marker holds.
 */

import { describe, expect, it } from "vitest";
import { mirrorParts } from "@/lib/explore/caret-position";

describe("mirrorParts", () => {
  it("splits at the caret with the next char as the marker", () => {
    expect(mirrorParts("SELECT signal", 7)).toEqual({ before: "SELECT ", marker: "s" });
  });

  it("uses a placeholder marker at the end of the text", () => {
    expect(mirrorParts("SELECT", 6)).toEqual({ before: "SELECT", marker: "." });
  });

  it("uses a placeholder marker at end-of-line (newline has no width)", () => {
    expect(mirrorParts("SELECT *\nFROM t", 8)).toEqual({ before: "SELECT *", marker: "." });
  });

  it("keeps a newline inside the before-text when the caret is past it", () => {
    expect(mirrorParts("SELECT *\nFROM t", 9)).toEqual({ before: "SELECT *\n", marker: "F" });
  });

  it("clamps an out-of-range caret to the text bounds", () => {
    expect(mirrorParts("abc", -2)).toEqual({ before: "", marker: "a" });
    expect(mirrorParts("abc", 99)).toEqual({ before: "abc", marker: "." });
  });

  it("handles empty text", () => {
    expect(mirrorParts("", 0)).toEqual({ before: "", marker: "." });
  });
});
