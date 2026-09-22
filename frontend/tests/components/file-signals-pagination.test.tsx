// The file detail embeds up to 500 signals in ONE response — the file route
// is not paged. The table holds that set on the client and pages it at 20,
// the same default as the run signals tab. The pager counts the rows the
// client holds, never the register count: a file that registers more than
// the fetch returned keeps its truncation note in the footer.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileSignal } from "@/types";

// RowLink navigates through the router. The table under test never navigates.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { FileSignalsTable } from "@/components/screens/files/file-signals-table";

const SIGNAL_TOTAL = 120;

const signals: FileSignal[] = Array.from({ length: SIGNAL_TOTAL }, (_, index) => ({
  name: `Signal_${index.toString().padStart(3, "0")}`,
  unit: "°C",
  unit_source: "embedded",
  rate_hz: 10,
  dtype: "float64",
  stats: { min: 1, max: 2, mean: 1.5, std: 0.5 },
}));

const nameCells = () => screen.getAllByText(/^Signal_\d{3}$/);
const pager = () => screen.getByRole("navigation", { name: "Pagination" });

describe("the file signals table pages on the client", () => {
  it("holds 20 rows on page 1, and page 2 holds the NEXT 20", async () => {
    const user = userEvent.setup();
    render(<FileSignalsTable signals={signals} signalCount={SIGNAL_TOTAL} />);

    expect(nameCells()).toHaveLength(20);
    expect(screen.getByText("Signal_000")).toBeInTheDocument();
    expect(screen.queryByText("Signal_020")).not.toBeInTheDocument();
    expect(pager()).toHaveTextContent(/Showing\s*1–20\s*of\s*120/);

    await user.click(screen.getByRole("button", { name: "Page 2" }));

    expect(nameCells()).toHaveLength(20);
    expect(screen.getByText("Signal_020")).toBeInTheDocument();
    expect(screen.queryByText("Signal_000")).not.toBeInTheDocument();
    expect(pager()).toHaveTextContent(/Showing\s*21–40\s*of\s*120/);
  });

  it("changes page from the keyboard", async () => {
    const user = userEvent.setup();
    render(<FileSignalsTable signals={signals} signalCount={SIGNAL_TOTAL} />);

    const next = screen.getByRole("button", { name: "Next page" });
    next.focus();
    await user.keyboard("{Enter}");

    expect(pager()).toHaveTextContent(/Showing\s*21–40\s*of\s*120/);
  });

  it("changes the page size and returns to page 1", async () => {
    const user = userEvent.setup();
    render(<FileSignalsTable signals={signals} signalCount={SIGNAL_TOTAL} />);

    await user.click(screen.getByRole("button", { name: "Page 2" }));
    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");

    expect(nameCells()).toHaveLength(100);
    expect(pager()).toHaveTextContent(/Showing\s*1–100\s*of\s*120/);
  });

  it("keeps the table a table — named, with scoped column headers", () => {
    render(<FileSignalsTable signals={signals} signalCount={SIGNAL_TOTAL} />);

    const table = screen.getByRole("table", { name: "Signals of this file" });
    expect(table.querySelector("thead")).not.toBeNull();
    for (const th of table.querySelectorAll("th")) {
      expect(th).toHaveAttribute("scope", "col");
    }
  });

  it("pins the column headers — the table sits in the shared scroll region", () => {
    render(<FileSignalsTable signals={signals} signalCount={SIGNAL_TOTAL} />);

    // globals.css keys the sticky thead on this opt-in class.
    expect(screen.getByRole("table").closest(".table-scroll")).not.toBeNull();
    // The pager stays OUTSIDE the scroll region, so it is always reachable.
    expect(pager().closest(".table-scroll")).toBeNull();
  });
});

describe("the honesty footer over a truncated fetch", () => {
  it("says the file registers more signals than the table holds", () => {
    render(<FileSignalsTable signals={signals} signalCount={261} />);

    expect(screen.getByRole("table")).toHaveTextContent(
      "The file registers 261 signals and this table holds the first 120."
    );
    // The pager counts the fetched rows. It never claims the register count.
    expect(pager()).toHaveTextContent(/Showing\s*1–20\s*of\s*120/);
    expect(pager()).not.toHaveTextContent("261");
  });

  it("stays silent when the fetch holds the whole file", () => {
    render(<FileSignalsTable signals={signals} signalCount={SIGNAL_TOTAL} />);

    expect(screen.getByRole("table").textContent).not.toMatch(/registers/);
  });
});
