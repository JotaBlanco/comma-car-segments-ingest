import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TableSearchInput } from "@/components/shared/table-search-input";

/**
 * fireEvent is used (rather than userEvent) so the input changes stay synchronous under
 * `vi.useFakeTimers()` — userEvent's own internal timers get tangled with the fake clock.
 */

describe("TableSearchInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces onDebouncedChange until the timer elapses", () => {
    const onDebouncedChange = vi.fn();
    render(
      <TableSearchInput
        value=""
        onDebouncedChange={onDebouncedChange}
        placeholder="Filter runs…"
        debounceMs={140}
      />
    );
    const input = screen.getByRole("searchbox", { name: "Filter runs…" });
    fireEvent.change(input, { target: { value: "derate" } });
    expect(onDebouncedChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(139);
    });
    expect(onDebouncedChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDebouncedChange).toHaveBeenCalledTimes(1);
    expect(onDebouncedChange).toHaveBeenCalledWith("derate");
  });

  it("resyncs local state when the external value changes", () => {
    const { rerender } = render(
      <TableSearchInput value="derate" onDebouncedChange={vi.fn()} placeholder="Filter runs…" />
    );
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    expect(input.value).toBe("derate");
    rerender(<TableSearchInput value="" onDebouncedChange={vi.fn()} placeholder="Filter runs…" />);
    expect(input.value).toBe("");
  });

  it("labels the input with the placeholder text", () => {
    render(
      <TableSearchInput value="" onDebouncedChange={vi.fn()} placeholder="Filter files…" />
    );
    expect(screen.getByRole("searchbox", { name: "Filter files…" })).toBeInTheDocument();
  });

  it("emits only the final value when multiple keystrokes land inside the debounce window", () => {
    const onDebouncedChange = vi.fn();
    render(
      <TableSearchInput
        value=""
        onDebouncedChange={onDebouncedChange}
        placeholder="Filter…"
        debounceMs={100}
      />
    );
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "ab" } });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    fireEvent.change(input, { target: { value: "abcd" } });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onDebouncedChange).toHaveBeenCalledTimes(1);
    expect(onDebouncedChange).toHaveBeenCalledWith("abcd");
  });
});
