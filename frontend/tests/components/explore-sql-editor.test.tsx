/**
 * SqlEditor — ghost-textarea behavior (plan §4).
 *
 *  - Ctrl/Cmd+Enter fires the run callback (plain Enter does not).
 *  - Snippet chips replace the editor content. (The old inline sql_rejected
 *    alert is gone with the guard — a DuckDB error is a query outcome and
 *    lands in the results panel's error state, covered there.)
 *  - Completion popup: opens while typing / on Ctrl+Space, arrows + Enter/Tab
 *    accept (columns bare, signals quoted), Escape dismisses WITHOUT reaching
 *    window-level listeners (the workbench's focus-mode Esc binding).
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SqlEditor } from "@/components/screens/run-detail/explore-tab/sql-editor";

function renderEditor(overrides: Partial<Parameters<typeof SqlEditor>[0]> = {}) {
  // The completion vocabulary carries the PHYSICAL spellings — here the v3
  // table, so the suite pins that completion never offers a logical name.
  const props = {
    value: "SELECT signal FROM test_signal_samples_v3",
    onChange: vi.fn(),
    onRun: vi.fn(),
    running: false,
    snippets: [{ label: "Per-signal stats", sql: "SELECT signal FROM test_signal_samples_v3 GROUP BY signal" }],
    table: "test_signal_samples_v3",
    columns: ["run_id", "signal", "ts_ms", "value", "file_name"],
    signals: ["engine_rpm", "engine_temp"],
    ...overrides,
  };
  render(<SqlEditor {...props} />);
  return props;
}

describe("SqlEditor", () => {
  it("fires onRun on Ctrl+Enter and Cmd+Enter, but not plain Enter", () => {
    const props = renderEditor();
    const editor = screen.getByLabelText("SQL editor");

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(props.onRun).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(props.onRun).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(props.onRun).toHaveBeenCalledTimes(2);
  });

  it("does not fire onRun while a query is already running", () => {
    const props = renderEditor({ running: true });
    fireEvent.keyDown(screen.getByLabelText("SQL editor"), { key: "Enter", ctrlKey: true });
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("renders no inline alert — errors belong to the results panel", () => {
    // The guard's 400 sql_rejected is dead: nothing emits it, so the editor
    // carries no rejection strip any more. A DuckDB error correctly lands in
    // the results panel's error state instead.
    renderEditor();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("snippet chips replace the editor content", () => {
    const props = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Per-signal stats" }));
    expect(props.onChange).toHaveBeenCalledWith(
      "SELECT signal FROM test_signal_samples_v3 GROUP BY signal",
    );
  });

  it("runs via the Run query button", () => {
    const props = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    expect(props.onRun).toHaveBeenCalledTimes(1);
  });

  it("shows a placeholder and disables Run for an empty editor", () => {
    const props = renderEditor({ value: "" });
    expect(screen.getByLabelText("SQL editor")).toHaveAttribute(
      "placeholder",
      expect.stringMatching(/SQL query/),
    );
    expect(screen.getByRole("button", { name: /Run query/ })).toBeDisabled();

    // Ctrl/Cmd+Enter is gated the same way — no empty query is ever sent.
    fireEvent.keyDown(screen.getByLabelText("SQL editor"), { key: "Enter", ctrlKey: true });
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("treats whitespace-only SQL as empty", () => {
    renderEditor({ value: "   \n  " });
    expect(screen.getByRole("button", { name: /Run query/ })).toBeDisabled();
  });

  it("prints the Run shortcut of the platform a person is using", () => {
    const real = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
    try {
      renderEditor();
      const run = screen.getByRole("button", { name: /Run query/ });
      expect(run).toHaveTextContent("Ctrl");
      expect(run.textContent).not.toContain("⌘");
    } finally {
      if (real) Object.defineProperty(navigator, "platform", real);
    }
  });
});

describe("SqlEditor completion popup", () => {
  function editor(): HTMLTextAreaElement {
    return screen.getByLabelText("SQL editor") as HTMLTextAreaElement;
  }

  it("opens while typing a word prefix and accepts a bare column with Enter", () => {
    const props = renderEditor({ value: "SELECT s" });
    const area = editor();

    fireEvent.change(area, { target: { value: "SELECT si" } });
    expect(screen.getByRole("listbox", { name: "SQL suggestions" })).toBeInTheDocument();
    expect(area).toHaveAttribute("aria-expanded", "true");
    // "si" only matches the signal COLUMN — one option, with its type hint.
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("signal");
    expect(options[0]).toHaveTextContent("varchar");

    fireEvent.keyDown(area, { key: "Enter" });
    // The column completes BARE and replaces the current word.
    expect(props.onChange).toHaveBeenLastCalledWith("SELECT signal");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("suggests only quoted signals after `signal = ` and arrows select", () => {
    const sql = "SELECT signal FROM test_signal_samples_v3 WHERE signal = ";
    const props = renderEditor({ value: sql });
    const area = editor();
    area.setSelectionRange(sql.length, sql.length);

    fireEvent.keyDown(area, { key: " ", ctrlKey: true });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("engine_rpm"),
      expect.stringContaining("engine_temp"),
    ]);

    fireEvent.keyDown(area, { key: "ArrowDown" });
    const selected = screen.getAllByRole("option")[1];
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(area.getAttribute("aria-activedescendant")).toBe(selected.id);

    fireEvent.keyDown(area, { key: "Enter" });
    // Signals are VALUES of the signal column — inserted single-quoted.
    expect(props.onChange).toHaveBeenLastCalledWith(`${sql}'engine_temp'`);
  });

  it("accepts an uppercase keyword with Tab", () => {
    const props = renderEditor({ value: "SELECT signal fr" });
    const area = editor();
    area.setSelectionRange(16, 16);

    fireEvent.keyDown(area, { key: " ", ctrlKey: true });
    expect(screen.getByRole("option", { name: "FROM" })).toBeInTheDocument();

    fireEvent.keyDown(area, { key: "Tab" });
    expect(props.onChange).toHaveBeenLastCalledWith("SELECT signal FROM");
  });

  it("Escape closes the popup and never reaches window listeners", () => {
    renderEditor({ value: "SELECT si" });
    const area = editor();
    area.setSelectionRange(9, 9);
    fireEvent.keyDown(area, { key: " ", ctrlKey: true });
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // The workbench binds Esc on window (exit focus mode / close panels) —
    // with the popup open the key must be consumed before it gets there.
    const windowSpy = vi.fn();
    window.addEventListener("keydown", windowSpy);
    fireEvent.keyDown(area, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(area).toHaveAttribute("aria-expanded", "false");
    expect(windowSpy).not.toHaveBeenCalled();

    // With the popup closed, Escape propagates as before.
    fireEvent.keyDown(area, { key: "Escape" });
    expect(windowSpy).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", windowSpy);
  });

  it("stays closed when the typed word matches nothing", () => {
    renderEditor({ value: "SELECT " });
    fireEvent.change(editor(), { target: { value: "SELECT zzz" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Ctrl+Enter still runs (and closes the popup) while it is open", () => {
    const props = renderEditor({ value: "SELECT si" });
    const area = editor();
    area.setSelectionRange(9, 9);
    fireEvent.keyDown(area, { key: " ", ctrlKey: true });
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    expect(props.onRun).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
