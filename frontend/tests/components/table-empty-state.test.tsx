import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TableEmptyState } from "@/components/shared/table-empty-state";

function wrap(row: React.ReactNode) {
  return (
    <table>
      <tbody>{row}</tbody>
    </table>
  );
}

describe("TableEmptyState", () => {
  it("renders the default message and clear-all action", () => {
    render(wrap(<TableEmptyState colSpan={8} onClearAll={vi.fn()} />));
    expect(screen.getByText(/Nothing matches the current filters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear everything" })).toBeInTheDocument();
  });

  it("spans the full colspan", () => {
    const { container } = render(wrap(<TableEmptyState colSpan={8} onClearAll={vi.fn()} />));
    const cell = container.querySelector("td");
    expect(cell).not.toBeNull();
    expect(cell?.getAttribute("colspan")).toBe("8");
  });

  it("fires onClearAll when the action button is clicked", async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    render(wrap(<TableEmptyState colSpan={5} onClearAll={onClearAll} />));
    await user.click(screen.getByRole("button", { name: "Clear everything" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("supports message and actionLabel overrides", () => {
    render(
      wrap(
        <TableEmptyState
          colSpan={3}
          onClearAll={vi.fn()}
          message="Nothing found."
          actionLabel="Reset"
        />
      )
    );
    expect(screen.getByText("Nothing found.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });
});
