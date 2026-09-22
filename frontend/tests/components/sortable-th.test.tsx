import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SortableTh } from "@/components/shared/sortable-th";

function wrap(cell: React.ReactNode) {
  // A `<th>` needs a table ancestry chain for RTL role queries to resolve properly.
  return (
    <table>
      <thead>
        <tr>{cell}</tr>
      </thead>
    </table>
  );
}

describe("SortableTh", () => {
  it("sets aria-sort='none' when this column is not the active sort", () => {
    render(
      wrap(
        <SortableTh
          label="Arrived"
          sortKey="first_data_at"
          active={{ key: "size_bytes", order: "asc" }}
          onSort={vi.fn()}
        />
      )
    );
    const th = screen.getByRole("columnheader");
    expect(th).toHaveAttribute("aria-sort", "none");
  });

  it("sets aria-sort='ascending' when active ascending", () => {
    render(
      wrap(
        <SortableTh
          label="Signal"
          sortKey="name"
          active={{ key: "name", order: "asc" }}
          onSort={vi.fn()}
        />
      )
    );
    expect(screen.getByRole("columnheader")).toHaveAttribute("aria-sort", "ascending");
  });

  it("sets aria-sort='descending' when active descending", () => {
    render(
      wrap(
        <SortableTh
          label="Arrived"
          sortKey="first_data_at"
          active={{ key: "first_data_at", order: "desc" }}
          onSort={vi.fn()}
        />
      )
    );
    expect(screen.getByRole("columnheader")).toHaveAttribute("aria-sort", "descending");
  });

  it("shows an arrow only when active (accent color applied)", () => {
    const { container, rerender } = render(
      wrap(
        <SortableTh
          label="Arrived"
          sortKey="first_data_at"
          active={null}
          onSort={vi.fn()}
        />
      )
    );
    // No aria-hidden arrow span while inactive.
    expect(container.querySelector("span[aria-hidden]")).toBeNull();

    rerender(
      wrap(
        <SortableTh
          label="Arrived"
          sortKey="first_data_at"
          active={{ key: "first_data_at", order: "asc" }}
          onSort={vi.fn()}
        />
      )
    );
    const arrow = container.querySelector("span[aria-hidden]");
    expect(arrow).not.toBeNull();
    expect(arrow?.textContent).toBe("↑");
    expect(arrow).toHaveClass("text-primary");
  });

  it("calls onSort with the column's sortKey on click", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(
      wrap(
        <SortableTh
          label="Arrived"
          sortKey="first_data_at"
          active={null}
          onSort={onSort}
        />
      )
    );
    await user.click(screen.getByRole("button", { name: /Arrived/ }));
    expect(onSort).toHaveBeenCalledWith("first_data_at");
  });

  it("is keyboard-activatable via the inner button", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(
      wrap(
        <SortableTh label="Arrived" sortKey="first_data_at" active={null} onSort={onSort} />
      )
    );
    const btn = screen.getByRole("button", { name: /Arrived/ });
    btn.focus();
    expect(btn).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSort).toHaveBeenCalledWith("first_data_at");
  });
});
