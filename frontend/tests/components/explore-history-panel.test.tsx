/**
 * Query history panel — renders recorded entries, opens them in a tab,
 * stars/unstars, and shows the empty state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryPanel } from "@/components/screens/run-detail/explore-tab/history-panel";
import { recordExploreHistory, resetHistoryCache } from "@/lib/explore/history-store";

const RUN = "TAS-88214";

beforeEach(() => {
  localStorage.clear();
  resetHistoryCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPanel(onOpenInTab = vi.fn(), onClose = vi.fn()) {
  render(<HistoryPanel runId={RUN} onOpenInTab={onOpenInTab} onClose={onClose} />);
  return { onOpenInTab, onClose };
}

describe("HistoryPanel", () => {
  it("shows the empty state before any run", () => {
    renderPanel();
    expect(screen.getByText(/No queries yet/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Query history" })).toBeInTheDocument();
  });

  it("lists recorded entries newest-first with status and counts", () => {
    recordExploreHistory(RUN, {
      sql: "SELECT signal FROM test_signal_samples",
      at: Date.now(),
      status: "ok",
      rowCount: 11,
      totalMs: 243,
    });
    recordExploreHistory(RUN, {
      sql: "SELECT broken",
      at: Date.now(),
      // The lake's own refusal (via 400 lake_query_error) — the only failure
      // kind left now the guard's "rejected" status is gone.
      status: "error",
      detail: "Binder Error: column broken does not exist",
    });
    renderPanel();
    expect(screen.getByText("SELECT signal FROM test_signal_samples")).toBeInTheDocument();
    expect(screen.getByText(/11 rows · 243 ms/)).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("hands an entry's SQL to the open-in-tab callback", async () => {
    const user = userEvent.setup();
    recordExploreHistory(RUN, { sql: "SELECT 42", at: Date.now(), status: "ok" });
    const { onOpenInTab } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Open in tab" }));
    expect(onOpenInTab).toHaveBeenCalledWith("SELECT 42");
  });

  it("stars an entry into the Saved group", async () => {
    const user = userEvent.setup();
    recordExploreHistory(RUN, { sql: "SELECT 1", at: Date.now(), status: "ok" });
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Save query" }));
    expect(screen.getByText(/Saved · 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unsave query" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("disables Open in tab at the workbench tab cap, with the reason as a title", () => {
    recordExploreHistory(RUN, { sql: "SELECT 42", at: Date.now(), status: "ok" });
    render(
      <HistoryPanel runId={RUN} onOpenInTab={vi.fn()} openInTabDisabled onClose={vi.fn()} />,
    );
    const button = screen.getByRole("button", { name: "Open in tab" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/Tab limit reached/));
  });

  it("closes through the close button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Close history" }));
    expect(onClose).toHaveBeenCalled();
  });
});
