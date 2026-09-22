/**
 * Schema rail — physical columns with type hints, click-to-insert (signals
 * insert as quoted SQL string values), and the under-listing honesty line.
 * The rail shows the PHYSICAL table and spellings the host resolved from the
 * server-read TM_LAKE_TABLE — the default render here is the v3 table
 * (ts_ms / file_name) to pin exactly that.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SchemaRail } from "@/components/screens/run-detail/explore-tab/schema-rail";
import type { FileSignal } from "@/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function signal(name: string): FileSignal {
  return {
    name,
    unit: "°C",
    unit_source: "embedded",
    rate_hz: 100,
    dtype: "float64",
    stats: null,
  };
}

function renderRail(
  signals: FileSignal[],
  signalTotal: number,
  onInsert = vi.fn(),
  onClose = vi.fn(),
) {
  render(
    <SchemaRail
      table="test_signal_samples_v3"
      columns={["run_id", "signal", "ts_ms", "value", "file_name"]}
      signals={signals}
      signalTotal={signalTotal}
      width={212}
      onWidthChange={() => undefined}
      onInsert={onInsert}
      onClose={onClose}
    />,
  );
  return { onInsert, onClose };
}

describe("SchemaRail", () => {
  it("lists the physical table's columns with type hints", () => {
    renderRail([signal("HV_Batt_Cell_Temp_Max")], 1);
    // The v3 physical spellings — exactly what the lake resolves.
    expect(screen.getByText("test_signal_samples_v3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ts_ms/ })).toHaveTextContent("epoch ms");
    expect(screen.getByRole("button", { name: /file_name/ })).toHaveTextContent("varchar");
    expect(screen.getByRole("button", { name: /^value/ })).toHaveTextContent("double");
  });

  it("inserts a column bare and a signal as a quoted value", async () => {
    const user = userEvent.setup();
    const { onInsert } = renderRail([signal("HV_Batt_Cell_Temp_Max")], 1);
    await user.click(screen.getByRole("button", { name: /^signal/ }));
    expect(onInsert).toHaveBeenLastCalledWith("signal");
    await user.click(screen.getByRole("button", { name: /HV_Batt_Cell_Temp_Max/ }));
    expect(onInsert).toHaveBeenLastCalledWith("'HV_Batt_Cell_Temp_Max'");
  });

  it("is a docked panel with a header and a close affordance", async () => {
    const user = userEvent.setup();
    const { onClose } = renderRail([signal("A")], 1);
    expect(screen.getByRole("region", { name: "Schema" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close schema" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("says when the page cap under-lists the run", () => {
    renderRail([signal("A"), signal("B")], 142);
    expect(screen.getByText("Showing 2 of 142 signals.")).toBeInTheDocument();
  });

  it("rounds a float-artefact rate and keeps clean rates clean", () => {
    const noisy = { ...signal("Wheel_Speed_FL"), rate_hz: 49.89996665555185 };
    renderRail([noisy, signal("HV_Batt_Cell_Temp_Max")], 2);
    expect(screen.getByRole("button", { name: /Wheel_Speed_FL/ })).toHaveTextContent("49.9 Hz");
    expect(screen.getByRole("button", { name: /HV_Batt_Cell_Temp_Max/ })).toHaveTextContent(
      "100 Hz",
    );
  });

  it("pins the signals heading and filter in one sticky opaque block", () => {
    // 21 signals pass the filter threshold, so the filter box renders.
    const many = Array.from({ length: 21 }, (_, index) => signal(`Sig_${index}`));
    renderRail(many, 21);
    const filterBox = screen.getByRole("searchbox", { name: "Filter signals" });
    // The heading and the filter share one sticky bar with its own surface,
    // so rows scroll beneath them without showing through.
    const stickyBlock = filterBox.closest(".sticky");
    expect(stickyBlock).not.toBeNull();
    expect(stickyBlock).toHaveTextContent(/signals in this run/i);
    expect(stickyBlock?.className).toContain("bg-surface");
  });

  it("exposes an accessible resize separator", () => {
    renderRail([signal("A")], 1);
    const separator = screen.getByRole("separator", { name: "Resize schema panel" });
    expect(separator).toHaveAttribute("aria-valuenow", "212");
  });
});
