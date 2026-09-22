import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

const UNITS = ["%RH", "bar", "rpm", "°C"];

function UnitAutocomplete({ onValueChange }: { onValueChange?: (value: string) => void }) {
  return (
    <Autocomplete items={UNITS} onValueChange={onValueChange}>
      <AutocompleteInput aria-label="Unit" placeholder="e.g. °C" />
      <AutocompleteContent>
        <AutocompleteEmpty>No matching unit.</AutocompleteEmpty>
        <AutocompleteList>
          {(unit: string) => (
            <AutocompleteItem key={unit} value={unit}>
              {unit}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompleteContent>
    </Autocomplete>
  );
}

function WorkOrderCombobox({ onValueChange }: { onValueChange?: (value: string | null) => void }) {
  return (
    <Combobox items={["WO-2026-0847", "WO-2026-0848", "WO-2026-0851"]} onValueChange={onValueChange}>
      <ComboboxInput aria-label="Work order" />
      <ComboboxContent>
        <ComboboxEmpty>No matching work order.</ComboboxEmpty>
        <ComboboxList>
          {(woId: string) => (
            <ComboboxItem key={woId} value={woId}>
              {woId}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

describe("Autocomplete (free-text variant)", () => {
  it("typing filters the suggestions to the matching ones", async () => {
    const user = userEvent.setup();
    render(<UnitAutocomplete />);

    await user.type(screen.getByRole("combobox", { name: "Unit" }), "r");

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["%RH", "bar", "rpm"]);
  });

  it("shows the empty message when nothing matches", async () => {
    const user = userEvent.setup();
    render(<UnitAutocomplete />);

    await user.type(screen.getByRole("combobox", { name: "Unit" }), "zzz");

    expect(await screen.findByText("No matching unit.")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("ArrowDown then Enter accepts the highlighted suggestion", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<UnitAutocomplete onValueChange={onValueChange} />);

    const input = screen.getByRole("combobox", { name: "Unit" });
    await user.type(input, "r");
    await screen.findAllByRole("option");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(input).toHaveValue("%RH");
    expect(onValueChange).toHaveBeenLastCalledWith("%RH", expect.anything());
  });

  it("free text stays legal — the typed value never resets to an option", async () => {
    const user = userEvent.setup();
    render(<UnitAutocomplete />);

    const input = screen.getByRole("combobox", { name: "Unit" });
    await user.type(input, "furlongs");

    expect(input).toHaveValue("furlongs");
  });

  it("Escape closes the popup and keeps the typed text", async () => {
    const user = userEvent.setup();
    render(<UnitAutocomplete />);

    const input = screen.getByRole("combobox", { name: "Unit" });
    await user.type(input, "r");
    await screen.findAllByRole("option");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(input).toHaveValue("r");
  });
});

describe("Combobox (single-select variant)", () => {
  it("typing filters and Enter selects the highlighted option", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<WorkOrderCombobox onValueChange={onValueChange} />);

    const input = screen.getByRole("combobox", { name: "Work order" });
    await user.type(input, "0848");
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onValueChange).toHaveBeenLastCalledWith("WO-2026-0848", expect.anything());
    expect(input).toHaveValue("WO-2026-0848");
  });

  it("clicking an option selects it", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<WorkOrderCombobox onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox", { name: "Work order" }));
    await user.click(await screen.findByRole("option", { name: "WO-2026-0851" }));

    expect(onValueChange).toHaveBeenLastCalledWith("WO-2026-0851", expect.anything());
  });

  it("a selected option carries aria-selected on reopen", async () => {
    const user = userEvent.setup();
    render(<WorkOrderCombobox />);

    const input = screen.getByRole("combobox", { name: "Work order" });
    await user.click(input);
    await user.click(await screen.findByRole("option", { name: "WO-2026-0847" }));
    await user.click(input);

    const selected = await screen.findByRole("option", { name: "WO-2026-0847" });
    expect(selected).toHaveAttribute("aria-selected", "true");
  });

  it("Escape closes the popup", async () => {
    const user = userEvent.setup();
    render(<WorkOrderCombobox />);

    await user.click(screen.getByRole("combobox", { name: "Work order" }));
    await screen.findAllByRole("option");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });
});
