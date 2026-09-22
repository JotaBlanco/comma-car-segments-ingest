import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActiveFilterPills, type FilterPill } from "@/components/shared/active-filter-pills";

describe("ActiveFilterPills", () => {
  it("renders nothing when pills is empty", () => {
    const { container } = render(<ActiveFilterPills pills={[]} onClearAll={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one pill per entry with the group and label visible", () => {
    const pills: readonly FilterPill[] = [
      { id: "status:invalid", group: "Status", label: "Invalid", onRemove: vi.fn() },
      { id: "q", group: "Search", label: "derate", onRemove: vi.fn() },
    ];
    render(<ActiveFilterPills pills={pills} onClearAll={vi.fn()} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("derate")).toBeInTheDocument();
  });

  it("labels each remove button with a descriptive aria-label", () => {
    const pills: readonly FilterPill[] = [
      { id: "status:invalid", group: "Status", label: "Invalid", onRemove: vi.fn() },
    ];
    render(<ActiveFilterPills pills={pills} onClearAll={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Remove filter: Status Invalid" })
    ).toBeInTheDocument();
  });

  it("fires onRemove for the specific pill when its × is clicked", async () => {
    const user = userEvent.setup();
    const removeStatus = vi.fn();
    const removeSearch = vi.fn();
    const pills: readonly FilterPill[] = [
      { id: "status:invalid", group: "Status", label: "Invalid", onRemove: removeStatus },
      { id: "q", group: "Search", label: "derate", onRemove: removeSearch },
    ];
    render(<ActiveFilterPills pills={pills} onClearAll={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Remove filter: Status Invalid" }));
    expect(removeStatus).toHaveBeenCalledTimes(1);
    expect(removeSearch).not.toHaveBeenCalled();
  });

  it("renders and fires the Clear all button when any pills are present", async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    const pills: readonly FilterPill[] = [
      { id: "q", group: "Search", label: "x", onRemove: vi.fn() },
    ];
    render(<ActiveFilterPills pills={pills} onClearAll={onClearAll} />);
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
