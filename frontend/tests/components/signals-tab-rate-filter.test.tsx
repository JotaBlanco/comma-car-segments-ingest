/**
 * The rate CELL rounds through formatRate, but the Rate filter builds its
 * option values from the raw rate_hz and matches rows on the raw value. Two
 * rows measured at 100.00166697227826 Hz display as "100 Hz", and the filter
 * must still find exactly those two. A filter built from the rounded display
 * would silently match nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { FileSignal } from "@/types";
import { formatRate } from "@/lib/format";

const FLOAT_RATE = 100.00166697227826;

const row = (name: string, rate: number): FileSignal => ({
  name,
  unit: "g",
  unit_source: "embedded",
  rate_hz: rate,
  dtype: "float64",
  stats: { min: 1, max: 2, mean: 1.5, std: 0.5 },
});

const RUN_ROWS: FileSignal[] = [
  row("Chassis_Accel_X", FLOAT_RATE),
  row("Chassis_Accel_Y", FLOAT_RATE),
  row("Wheel_Speed_FL", 10),
];

vi.mock("@/lib/hooks", () => ({
  usePageTitle: () => undefined,
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useSignalFacets: () => ({
    data: { units: [], rates: [], rigs: [] },
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
  useRunSignals: () => ({
    data: {
      items: RUN_ROWS,
      total: RUN_ROWS.length,
      page: 1,
      page_size: 20,
      total_pages: 1,
    },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

import { SignalsTab } from "@/components/screens/run-detail/signals-tab";

/** The signal names the table shows, read off the row checkboxes. */
function shownNames(): string[] {
  return screen
    .getAllByRole("checkbox")
    .map((box) => box.getAttribute("aria-label") ?? "")
    .filter((label) => label.startsWith("Select ") && !label.startsWith("Select every"))
    .map((label) => label.slice("Select ".length));
}

async function openRateFilter(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: /^Rate/, expanded: false }));
  return within(await screen.findByRole("dialog", { name: "Rate filter" }));
}

describe("the rate filter after the display started rounding", () => {
  it("shows the rounded rate in the cells", () => {
    render(<SignalsTab runId="TAS-90001" signalCount={3} selected={[]} onSelectedChange={() => {}} />);

    const cell = screen.getByText("Chassis_Accel_X").closest("tr") as HTMLElement;
    expect(within(cell).getByText("100 Hz")).toBeInTheDocument();
    expect(cell.textContent).not.toContain(String(FLOAT_RATE));
  });

  it("still matches the rows that carry the raw float rate", async () => {
    const user = userEvent.setup();
    render(<SignalsTab runId="TAS-90001" signalCount={3} selected={[]} onSelectedChange={() => {}} />);
    expect(shownNames()).toHaveLength(3);

    const popover = await openRateFilter(user);
    /* The option LABEL rounds, like the column beside it — a dropdown offering
       `100.00166697227826 Hz` next to a cell reading `100 Hz` reads as two
       different rates. The option VALUE stays the raw float, because that is
       what the rows carry and what the filter matches on. Clicking the rounded
       label and still getting exactly the float-rate rows is the whole point
       of this test. */
    await user.click(popover.getByText(`${formatRate(FLOAT_RATE)} Hz`));
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(shownNames()).toEqual(["Chassis_Accel_X", "Chassis_Accel_Y"]),
    );
  });

  it("still matches a clean whole rate", async () => {
    const user = userEvent.setup();
    render(<SignalsTab runId="TAS-90001" signalCount={3} selected={[]} onSelectedChange={() => {}} />);

    const popover = await openRateFilter(user);
    await user.click(popover.getByText("10 Hz"));
    await user.keyboard("{Escape}");

    await waitFor(() => expect(shownNames()).toEqual(["Wheel_Speed_FL"]));
  });
});
