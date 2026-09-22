/**
 * Filtering the Signals tab of the run detail screen.
 *
 * The tab holds the run's rows already, so every filter runs on the client and
 * every option list comes from those same rows. These tests hold the tab the
 * way `RunDetailScreen` holds it — the screen owns the QuixLab pick and prints
 * the strip count — so the numbers a person reads are what the tests read.
 */
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { FileSignal } from "@/types";

const RUN_ID = "TAS-90001";

const stats = { min: 1, max: 9, mean: 4.5, std: 0.5 };

/** One small run: 11 signals, 6 units, 2 rows with no unit, 3 blank rows. */
const RUN_ROWS: FileSignal[] = [
  { name: "Engine_Speed", unit: "rpm", unit_source: "embedded", rate_hz: 100, dtype: "float64", stats },
  { name: "Engine_Torque", unit: "Nm", unit_source: "manual", rate_hz: 100, dtype: "float64", stats: null },
  { name: "Coolant_Temp", unit: "°C", unit_source: "embedded", rate_hz: 10, dtype: "float64", stats },
  { name: "Oil_Temp", unit: "°C", unit_source: "embedded", rate_hz: 10, dtype: "float64", stats: null },
  { name: "Ambient_Temp", unit: "°C", unit_source: "api:bench", rate_hz: 10, dtype: "float64", stats },
  { name: "Brake_Pressure", unit: "bar", unit_source: "embedded", rate_hz: 50, dtype: "float64", stats },
  { name: "Fuel_Rail_Pressure", unit: "bar", unit_source: "embedded", rate_hz: 50, dtype: "float64", stats },
  { name: "Throttle_Position", unit: null, unit_source: null, rate_hz: 50, dtype: "float64", stats },
  { name: "Gear_Selected", unit: null, unit_source: null, rate_hz: 10, dtype: "int32", stats: null },
  { name: "Vehicle_Speed", unit: "km/h", unit_source: "embedded", rate_hz: 100, dtype: "float64", stats },
  { name: "Battery_Voltage", unit: "V", unit_source: "embedded", rate_hz: 10, dtype: "float64", stats },
];

const TOTAL = RUN_ROWS.length;

// The stub pages the way the route pages. One page holds this whole run.
vi.mock("@/lib/hooks", () => ({
  usePageTitle: () => undefined,
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useSignalFacets: () => ({
    // The catalogue's units, NOT this run's. The tab must never build a filter
    // option from this list: `%` belongs to another run.
    data: { units: ["%", "°C", "rpm"], rates: [1, 10], rigs: [] },
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
  useRunSignals: (_runId: string, params: { page?: number; page_size?: number }) => {
    const page = params.page ?? 1;
    const pageSize = params.page_size ?? 200;
    const start = (page - 1) * pageSize;
    return {
      data: {
        items: RUN_ROWS.slice(start, start + pageSize),
        total: TOTAL,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(TOTAL / pageSize),
        stats_unavailable: { reason: "partly_measured" },
      },
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    };
  },
}));

import { SignalsTab } from "@/components/screens/run-detail/signals-tab";

/** The tab under the owner that holds the pick and prints the strip count. */
function Harness() {
  const [picked, setPicked] = useState<string[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  return (
    <>
      <div data-testid="strip">Signals {shown ?? TOTAL}</div>
      <SignalsTab
        runId={RUN_ID}
        signalCount={TOTAL}
        selected={picked}
        onSelectedChange={setPicked}
        onShownCountChange={setShown}
      />
    </>
  );
}

/** The signal names the table shows, read off the row checkboxes. */
function shownNames(): string[] {
  return screen
    .getAllByRole("checkbox")
    .map((box) => box.getAttribute("aria-label") ?? "")
    .filter((label) => label.startsWith("Select ") && !label.startsWith("Select every"))
    .map((label) => label.slice("Select ".length));
}

const pager = () => screen.getByRole("navigation", { name: "Pagination" });
const strip = () => screen.getByTestId("strip");
const summary = () => screen.getByRole("group", { name: "Signals picked for QuixLab" });

/** Type in the name box and wait for the debounce to land. */
async function typeSearch(user: UserEvent, text: string): Promise<void> {
  const box = screen.getByRole("searchbox", { name: "Filter signals by name…" });
  await user.clear(box);
  if (text.length > 0) await user.type(box, text);
  await waitFor(() => expect(box).toHaveValue(text));
}

/* The option rows carry the value on `aria-label`, but the surrounding
   `<label>` also points at the checkbox, so the computed name is not that
   value. Click the visible text, the way the other filter tests do. */
async function openFilter(user: UserEvent, label: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${label}`), expanded: false }));
  return within(await screen.findByRole("dialog", { name: `${label} filter` }));
}

/** Open one filter popover, tick one option and close the popover again. */
async function pickOption(user: UserEvent, label: string, option: string): Promise<void> {
  const popover = await openFilter(user, label);
  await user.click(popover.getByText(option));
  await user.keyboard("{Escape}");
}

describe("the Signals tab filters the run's own rows", () => {
  it("narrows by name, whatever the case, on any part of the name", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(shownNames()).toHaveLength(TOTAL);

    await typeSearch(user, "tEmP");

    await waitFor(() =>
      expect(shownNames()).toEqual(["Coolant_Temp", "Oil_Temp", "Ambient_Temp"]),
    );
  });

  it("narrows by unit", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await pickOption(user, "Unit", "°C");

    await waitFor(() =>
      expect(shownNames()).toEqual(["Coolant_Temp", "Oil_Temp", "Ambient_Temp"]),
    );
  });

  it("finds the rows that carry no unit at all", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await pickOption(user, "Unit", "No unit");

    await waitFor(() => expect(shownNames()).toEqual(["Throttle_Position", "Gear_Selected"]));
  });

  it("narrows by rate", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await pickOption(user, "Rate", "50 Hz");

    await waitFor(() =>
      expect(shownNames()).toEqual(["Brake_Pressure", "Fuel_Rail_Pressure", "Throttle_Position"]),
    );
  });

  it("finds the blank rows, and the measured rows", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const views = screen.getByRole("group", { name: "Signal value views" });

    await user.click(within(views).getByRole("button", { name: /^Blank/ }));
    await waitFor(() =>
      expect(shownNames()).toEqual(["Engine_Torque", "Oil_Temp", "Gear_Selected"]),
    );

    await user.click(within(views).getByRole("button", { name: /^Measured/ }));
    await waitFor(() => expect(shownNames()).toHaveLength(8));
    expect(shownNames()).not.toContain("Oil_Temp");
  });

  it("stacks two filters", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await pickOption(user, "Unit", "°C");
    await typeSearch(user, "oil");

    await waitFor(() => expect(shownNames()).toEqual(["Oil_Temp"]));
  });
});

describe("every option comes from this run's rows", () => {
  it("offers the run's units, and no unit from the wider catalogue", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const unit = await openFilter(user, "Unit");
    const names = unit.getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"));

    expect(names).toEqual(["Nm", "V", "bar", "km/h", "rpm", "°C", "No unit"]);
    // `%` sits in the facets stub. No signal of this run carries it.
    expect(names).not.toContain("%");
  });

  it("offers the run's rates, in order, and no rate from the wider catalogue", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const rate = await openFilter(user, "Rate");
    const names = rate.getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"));

    expect(names).toEqual(["10", "50", "100"]);
    // 1 Hz sits in the facets stub, and in no row of this run.
    expect(names).not.toContain("1");
  });
});

describe("the counts follow the filter", () => {
  it("states the shown count in the pager line", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(pager()).toHaveTextContent(/Showing\s*1–11\s*of\s*11/);

    await typeSearch(user, "temp");

    await waitFor(() => expect(pager()).toHaveTextContent(/Showing\s*1–3\s*of\s*3/));
    expect(shownNames()).toHaveLength(3);
  });

  it("hands the shown count to the tab strip, and gives it back on clear", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(strip()).toHaveTextContent("Signals 11");

    await typeSearch(user, "temp");
    await waitFor(() => expect(strip()).toHaveTextContent("Signals 3"));

    await typeSearch(user, "");
    await waitFor(() => expect(strip()).toHaveTextContent("Signals 11"));
  });
});

describe("a picked signal a filter then hides", () => {
  it("stays picked, and the tab says how many are hidden", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: "Select Engine_Speed" }));
    expect(summary()).toHaveTextContent("1 signal picked for QuixLab.");

    await typeSearch(user, "temp");

    await waitFor(() => expect(shownNames()).toHaveLength(3));
    // The pick survives the filter — a filter is a view, not an unpick.
    expect(summary()).toHaveTextContent("1 signal picked for QuixLab.");
    // And the tab states it, so nothing travels to QuixLab unseen.
    expect(summary()).toHaveTextContent("1 of them is hidden by the filters, and stay picked.");
  });

  it("picks the shown rows only from the header box", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await typeSearch(user, "temp");
    await waitFor(() => expect(shownNames()).toHaveLength(3));

    await user.click(screen.getByRole("checkbox", { name: "Select every signal shown" }));

    expect(summary()).toHaveTextContent("3 signals picked for QuixLab.");
  });
});

describe("nothing matches", () => {
  it("states it, and clears every filter from the empty state", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await pickOption(user, "Unit", "rpm");
    await typeSearch(user, "temp");

    await waitFor(() => expect(shownNames()).toHaveLength(0));
    expect(screen.getByRole("table")).toHaveTextContent("No signal matches these filters.");

    await user.click(screen.getByRole("button", { name: "Clear everything" }));

    await waitFor(() => expect(shownNames()).toHaveLength(TOTAL));
    expect(pager()).toHaveTextContent(/Showing\s*1–11\s*of\s*11/);
  });

  it("keeps the table named, and every filter control named", () => {
    render(<Harness />);

    expect(screen.getByRole("table", { name: "Signals of this run" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Filter signals by name…" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Signal value views" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Unit/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Rate/ })).toBeInTheDocument();
  });
});

describe("the removable pills", () => {
  it("shows one pill per applied value, and removes it from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await pickOption(user, "Unit", "°C");

    const pills = screen.getByRole("list", { name: "Applied filters" });
    const remove = within(pills).getByRole("button", { name: "Remove filter: Unit °C" });
    remove.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(shownNames()).toHaveLength(TOTAL));
    expect(screen.queryByRole("list", { name: "Applied filters" })).toBeNull();
  });
});
