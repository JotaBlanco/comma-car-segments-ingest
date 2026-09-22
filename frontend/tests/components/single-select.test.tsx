/**
 * The shared single-select — the app's stand-in for a native `<select>`.
 *
 * A native `<select>` gets its name, its keyboard work and its focus return
 * from the browser. This control gets them from Base UI plus wiring in
 * `components/shared/single-select.tsx`, so this file proves each one:
 *
 *   1. the visible label really names the trigger;
 *   2. the popup states itself (`aria-haspopup`, `aria-expanded`);
 *   3. mouse and keyboard both pick, Escape closes, focus returns;
 *   4. a disabled option stays visible and refuses the pick.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SingleSelect, type SingleSelectProps } from "@/components/shared/single-select";

const UNITS = [
  { value: "c", label: "°C" },
  { value: "bar", label: "bar" },
  { value: "rpm", label: "rpm", disabled: true },
] as const;

function Unit(over: Partial<SingleSelectProps> = {}) {
  return (
    <SingleSelect
      label="Unit"
      value={null}
      onChange={vi.fn()}
      placeholder="Choose a unit"
      options={UNITS}
      {...over}
    />
  );
}

const trigger = () => screen.getByLabelText("Unit");

describe("the trigger", () => {
  it("takes its name from the visible label", () => {
    render(<Unit />);

    expect(trigger()).toHaveAccessibleName("Unit");
    expect(screen.getByText("Unit")).toBeVisible();
  });

  it("shows the placeholder with no value, and the picked label with one", () => {
    const { rerender } = render(<Unit />);
    expect(trigger()).toHaveTextContent("Choose a unit");

    rerender(<Unit value="c" />);
    expect(trigger()).toHaveTextContent("°C");
    // The label, never the raw wire value.
    expect(trigger()).not.toHaveTextContent(/^c$/);
  });

  it("states the popup: aria-haspopup, and aria-expanded follows it", async () => {
    const user = userEvent.setup();
    render(<Unit />);

    expect(trigger()).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger());

    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });
});

describe("picking", () => {
  it("a click picks an option, closes the popup and returns focus", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Unit onChange={onChange} />);

    await user.click(trigger());
    await user.click(await screen.findByRole("option", { name: "bar" }));

    expect(onChange).toHaveBeenCalledWith("bar");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
  });

  it("the keyboard alone picks: open, arrow, Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Unit onChange={onChange} />);

    await user.tab();
    expect(trigger()).toHaveFocus();

    await user.keyboard("{Enter}");
    await screen.findByRole("listbox");
    // Opening highlights the first option, so one ArrowDown reaches the second.
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith("bar");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
  });

  it("Escape closes without a pick, and focus comes back to the trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Unit onChange={onChange} />);

    await user.click(trigger());
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
  });

  it("a disabled option stays visible and refuses the pick", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Unit onChange={onChange} />);

    await user.click(trigger());
    const stopped = await screen.findByRole("option", { name: "rpm" });
    expect(stopped).toHaveAttribute("aria-disabled", "true");

    await user.click(stopped);

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("groups", () => {
  it("renders each named group, and every option under its heading", async () => {
    const user = userEvent.setup();
    render(
      <SingleSelect
        label="Unit"
        value={null}
        onChange={vi.fn()}
        groups={[
          { label: "Temperature", options: [{ value: "c", label: "°C" }] },
          { label: "Pressure", options: [{ value: "bar", label: "bar" }] },
          // An empty group renders nothing: a heading over nothing reads
          // as a fault.
          { label: "Speed", options: [] },
        ]}
      />,
    );

    await user.click(trigger());

    const temperature = await screen.findByRole("group", { name: "Temperature" });
    expect(temperature).toHaveTextContent("°C");
    expect(screen.getByRole("group", { name: "Pressure" })).toHaveTextContent("bar");
    expect(screen.queryByRole("group", { name: "Speed" })).not.toBeInTheDocument();
  });
});
