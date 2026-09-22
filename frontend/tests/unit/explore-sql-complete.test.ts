/**
 * sql-complete — pure completion vocabulary + caret-context analysis for the
 * SQL editor's popup. Pins the closed contract: columns complete bare,
 * signals complete quoted, string/`signal =`/`IN (` positions are closed to
 * signals only, and nothing the guard rejects (comments, other tables) is
 * ever offered. The vocabulary here is the PHYSICAL v3 spelling (table
 * `test_signal_samples_v3`, columns `ts_ms` / `file_name`) — completion must
 * offer the identifiers the lake actually resolves.
 */

import { describe, expect, it } from "vitest";
import {
  buildCompletions,
  completionQueryAt,
  type CompletionVocabulary,
} from "@/lib/explore/sql-complete";

const vocab: CompletionVocabulary = {
  table: "test_signal_samples_v3",
  columns: ["run_id", "signal", "ts_ms", "value", "file_name"],
  signals: ["engine_rpm", "engine_temp"],
};

describe("completionQueryAt", () => {
  it("extracts the word before the caret as the replacement range", () => {
    expect(completionQueryAt("SELECT si", 9)).toEqual({
      start: 7,
      end: 9,
      prefix: "si",
      signalPosition: false,
    });
  });

  it("flags the position after `signal =` as a signal-value slot", () => {
    const query = completionQueryAt("WHERE signal = ", 15);
    expect(query.signalPosition).toBe(true);
    expect(query.prefix).toBe("");
  });

  it("flags the position after `IN (` as a signal-value slot", () => {
    expect(completionQueryAt("WHERE signal IN (", 17).signalPosition).toBe(true);
  });

  it("treats an odd quote count as inside a string, replacing the literal", () => {
    const query = completionQueryAt("WHERE signal = 'eng", 19);
    expect(query).toEqual({ start: 15, end: 19, prefix: "eng", signalPosition: true });
  });

  it("swallows an existing closing quote after the caret", () => {
    // caret between "eng" and the closing quote
    expect(completionQueryAt("WHERE signal = 'eng'", 19).end).toBe(20);
  });

  it("counts '' escapes as two quotes so parity stays truthful", () => {
    // 4 quotes before the caret — the literal is closed, back to word mode.
    const query = completionQueryAt("WHERE signal = 'it''s' AND va", 29);
    expect(query.signalPosition).toBe(false);
    expect(query.prefix).toBe("va");
  });
});

describe("buildCompletions", () => {
  it("offers only quoted signals in a signal-value position", () => {
    const items = buildCompletions(completionQueryAt("WHERE signal = ", 15), vocab);
    expect(items.map((item) => item.insert)).toEqual(["'engine_rpm'", "'engine_temp'"]);
    expect(items.every((item) => item.kind === "signal")).toBe(true);
  });

  it("escapes quotes inside a signal name", () => {
    const items = buildCompletions(completionQueryAt("WHERE signal = ", 15), {
      ...vocab,
      signals: ["o'clock"],
    });
    expect(items[0].insert).toBe("'o''clock'");
  });

  it("completes columns bare with their type hints — physical spellings included", () => {
    const items = buildCompletions(completionQueryAt("SELECT ts", 9), vocab);
    expect(items).toContainEqual({
      label: "ts_ms",
      insert: "ts_ms",
      kind: "column",
      detail: "bigint · epoch ms",
    });
    const fileItems = buildCompletions(completionQueryAt("SELECT file", 11), vocab);
    expect(fileItems).toContainEqual({
      label: "file_name",
      insert: "file_name",
      kind: "column",
      detail: "varchar",
    });
  });

  it("matches keywords case-insensitively and inserts them uppercase", () => {
    const items = buildCompletions(completionQueryAt("sel", 3), vocab);
    expect(items.map((item) => item.insert)).toContain("SELECT");
  });

  it("offers the compound GROUP BY form for a `gro` prefix", () => {
    const items = buildCompletions(completionQueryAt("SELECT signal gro", 17), vocab);
    expect(items.map((item) => item.insert)).toEqual(["GROUP BY"]);
  });

  it("offers the physical table and, outside string positions, quoted signals", () => {
    const items = buildCompletions(completionQueryAt("FROM te", 7), vocab);
    expect(items.map((item) => item.insert)).toContain("test_signal_samples_v3");
    const all = buildCompletions(completionQueryAt("", 0), vocab);
    const signal = all.find((item) => item.kind === "signal");
    expect(signal?.insert).toBe("'engine_rpm'");
  });

  it("never suggests comments — the guard rejects them", () => {
    const all = buildCompletions(completionQueryAt("", 0), vocab);
    expect(all.some((item) => item.insert.includes("--"))).toBe(false);
  });
});
