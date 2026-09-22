import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TablePager, computePagerSequence } from "@/components/shared/table-pager";

describe("computePagerSequence", () => {
  it("returns [1] when there is a single page", () => {
    expect(computePagerSequence(1, 1)).toEqual([1]);
    // 0 totalPages is coerced to 1 by the caller, so this only guards the pure fn.
    expect(computePagerSequence(1, 0)).toEqual([1]);
  });

  it("shows 1..n without ellipsis when the count is small", () => {
    expect(computePagerSequence(2, 3)).toEqual([1, 2, 3]);
    expect(computePagerSequence(1, 3)).toEqual([1, 2, 3]);
  });

  it("inserts one ellipsis on the right at page 1 of a large set", () => {
    expect(computePagerSequence(1, 20)).toEqual([1, 2, "ellipsis", 20]);
  });

  it("inserts ellipses on both sides in the middle of a large set", () => {
    expect(computePagerSequence(5, 20)).toEqual([1, "ellipsis", 4, 5, 6, "ellipsis", 20]);
  });

  it("inserts one ellipsis on the left at the last page", () => {
    expect(computePagerSequence(20, 20)).toEqual([1, "ellipsis", 19, 20]);
  });
});

describe("TablePager", () => {
  it("renders the range 'Showing X–Y of N' when total > 0", () => {
    render(
      <TablePager
        page={2}
        pageSize={20}
        total={128}
        totalPages={7}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />
    );
    // The bold segments are separated in the DOM; regex tolerates that.
    expect(screen.getByRole("navigation", { name: "Pagination" })).toHaveTextContent(
      /Showing\s*21–40\s*of\s*128/
    );
  });

  it("renders '0 results' when total is zero", () => {
    render(
      <TablePager
        page={1}
        pageSize={20}
        total={0}
        totalPages={1}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />
    );
    expect(screen.getByRole("navigation")).toHaveTextContent(/0\s*results/);
  });

  it("marks the current page with aria-current='page'", () => {
    render(
      <TablePager
        page={5}
        pageSize={20}
        total={400}
        totalPages={20}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />
    );
    const current = screen.getByRole("button", { name: "Page 5" });
    expect(current).toHaveAttribute("aria-current", "page");
    const other = screen.getByRole("button", { name: "Page 4" });
    expect(other).not.toHaveAttribute("aria-current");
  });

  it("disables Previous on page 1 and Next on the last page", () => {
    const { rerender } = render(
      <TablePager
        page={1}
        pageSize={20}
        total={40}
        totalPages={2}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();

    rerender(
      <TablePager
        page={2}
        pageSize={20}
        total={40}
        totalPages={2}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Previous page" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("fires onPageChange with the target page number when a numbered button is clicked", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <TablePager
        page={1}
        pageSize={20}
        total={400}
        totalPages={20}
        onPageChange={onPageChange}
        onPageSizeChange={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Page 2" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("fires onPageChange with page-1 when Previous is clicked", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <TablePager
        page={3}
        pageSize={20}
        total={400}
        totalPages={20}
        onPageChange={onPageChange}
        onPageSizeChange={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("fires onPageSizeChange with the numeric value when Rows changes", async () => {
    const user = userEvent.setup();
    const onPageSizeChange = vi.fn();
    render(
      <TablePager
        page={1}
        pageSize={20}
        total={400}
        totalPages={20}
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />
    );
    const select = screen.getByRole("combobox", { name: "Rows per page" });
    await user.selectOptions(select, "50");
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it("exposes all six page-size options 10/20/50/100/200/500", () => {
    render(
      <TablePager
        page={1}
        pageSize={20}
        total={400}
        totalPages={20}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />
    );
    const options = screen
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(["10", "20", "50", "100", "200", "500"]);
  });
});
