import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiSelectFilter, type FilterOption } from "@/components/shared/multi-select-filter";

const options: readonly FilterOption[] = [
  { value: "complete", label: "Linked" },
  { value: "awaiting_work_order", label: "Awaiting work order" },
  { value: "invalid", label: "Invalid" },
];

describe("MultiSelectFilter", () => {
  it("renders the trigger with no count badge when nothing is selected", () => {
    render(
      <MultiSelectFilter label="Status" options={options} selected={[]} onChange={vi.fn()} />
    );
    const trigger = screen.getByRole("button", { name: /Status/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // No count badge exists when unapplied.
    expect(screen.queryByLabelText(/selected/)).not.toBeInTheDocument();
  });

  it("shows a count pill matching selected.length when applied", () => {
    render(
      <MultiSelectFilter
        label="Status"
        options={options}
        selected={["invalid", "complete"]}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText("2 selected")).toHaveTextContent("2");
  });

  it("opens the popover, toggles a value, and calls onChange with the new selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MultiSelectFilter
        label="Status"
        options={options}
        selected={[]}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /Status/ }));
    // Click the option row (a <label>) — the wrapped Checkbox toggles as a result.
    const invalidRow = await screen.findByText("Invalid");
    await user.click(invalidRow);
    expect(onChange).toHaveBeenCalledWith(["invalid"]);
  });

  it("removes a value on toggle when it was already selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MultiSelectFilter
        label="Status"
        options={options}
        selected={["invalid", "complete"]}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /Status/ }));
    const completeRow = await screen.findByText("Linked");
    await user.click(completeRow);
    expect(onChange).toHaveBeenCalledWith(["invalid"]);
  });

  it("Clear button empties the selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MultiSelectFilter
        label="Status"
        options={options}
        selected={["invalid"]}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /Status/ }));
    const clearBtn = await screen.findByRole("button", { name: "Clear" });
    await user.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("Clear is disabled when nothing is selected", async () => {
    const user = userEvent.setup();
    render(
      <MultiSelectFilter label="Status" options={options} selected={[]} onChange={vi.fn()} />
    );
    await user.click(screen.getByRole("button", { name: /Status/ }));
    const clearBtn = await screen.findByRole("button", { name: "Clear" });
    expect(clearBtn).toBeDisabled();
  });

  it("shows no search box at or below the threshold", async () => {
    const user = userEvent.setup();
    render(
      <MultiSelectFilter label="Status" options={options} selected={[]} onChange={vi.fn()} />
    );
    await user.click(screen.getByRole("button", { name: /Status/ }));
    await screen.findByText("Linked");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  describe("with more options than the search threshold", () => {
    const manyOptions: readonly FilterOption[] = Array.from({ length: 10 }, (_, index) => ({
      value: `RIG-0${index}`,
      label: `RIG-0${index}`,
    }));

    it("narrows the visible options by substring, selection semantics untouched", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <MultiSelectFilter
          label="Rig"
          options={manyOptions}
          selected={["RIG-01"]}
          onChange={onChange}
        />
      );
      await user.click(screen.getByRole("button", { name: /Rig/ }));
      const search = await screen.findByRole("searchbox", { name: "Search rig options" });
      await user.type(search, "RIG-07");

      // Only the match is visible; picking it ADDS to the selection.
      expect(screen.getByText("RIG-07")).toBeInTheDocument();
      expect(screen.queryByText("RIG-02")).not.toBeInTheDocument();
      await user.click(screen.getByText("RIG-07"));
      expect(onChange).toHaveBeenCalledWith(["RIG-01", "RIG-07"]);
    });

    it("states when no option matches the search", async () => {
      const user = userEvent.setup();
      render(
        <MultiSelectFilter label="Rig" options={manyOptions} selected={[]} onChange={vi.fn()} />
      );
      await user.click(screen.getByRole("button", { name: /Rig/ }));
      const search = await screen.findByRole("searchbox", { name: "Search rig options" });
      await user.type(search, "zzz");
      expect(screen.getByText(/No option matches/)).toBeInTheDocument();
    });

    it("a reopened popover forgets the search", async () => {
      const user = userEvent.setup();
      render(
        <MultiSelectFilter label="Rig" options={manyOptions} selected={[]} onChange={vi.fn()} />
      );
      const trigger = screen.getByRole("button", { name: /Rig/ });
      await user.click(trigger);
      await user.type(
        await screen.findByRole("searchbox", { name: "Search rig options" }),
        "RIG-07"
      );
      await user.keyboard("{Escape}");
      await user.click(trigger);
      const search = await screen.findByRole("searchbox", { name: "Search rig options" });
      expect(search).toHaveValue("");
      expect(screen.getByText("RIG-02")).toBeInTheDocument();
    });
  });

  it("Done closes the popover", async () => {
    const user = userEvent.setup();
    render(
      <MultiSelectFilter label="Status" options={options} selected={[]} onChange={vi.fn()} />
    );
    const trigger = screen.getByRole("button", { name: /Status/ });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const doneBtn = await screen.findByRole("button", { name: "Done" });
    await user.click(doneBtn);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
