/**
 * The sidebar collapses to an icon rail, like the Quix Portal sidenav.
 *
 * The rail must lose no information: the label and the count leave the screen
 * but stay in the accessible name, and the stored state survives a reload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

vi.mock("@/lib/hooks", () => ({
  useHomeSummary: () => ({
    data: { counts: { test_runs: 12, work_orders: 3, test_definitions: 5, files: 41, signals: 186 } },
  }),
  usePlanningSyncStatus: () => ({ data: { online: true } }),
}));

import { Sidebar, SIDEBAR_STORAGE_KEY } from "@/components/shell/sidebar";

const toggleName = /(Collapse|Expand) sidebar/;

/* jsdom loads no stylesheet, so `toBeVisible` cannot see the Tailwind
   `sr-only` rule. The class is the visual state of the label here. */
const hiddenFromSight = (text: string): boolean =>
  screen.getByText(text).classList.contains("sr-only");

describe("the sidebar collapse toggle", () => {
  beforeEach(() => {
    pathname = "/runs";
    localStorage.clear();
  });

  it("starts expanded and reports it on the toggle", () => {
    render(<Sidebar />);

    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(hiddenFromSight("Test runs")).toBe(false);
  });

  it("collapses and expands again from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);

    const toggle = screen.getByRole("button", { name: toggleName });
    toggle.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("hides the labels, the counts and the section heading when collapsed", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);

    expect(screen.getByText("Registry")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: toggleName }));

    expect(screen.queryByText("Registry")).toBeNull();
    expect(hiddenFromSight("Test runs")).toBe(true);
    expect(hiddenFromSight("12")).toBe(true);
  });

  it("keeps the label and the count in the accessible name of a collapsed entry", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: toggleName }));

    expect(screen.getByRole("link", { name: "Test runs 12" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Signals 186" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Test definitions 5" })).toBeInTheDocument();
  });

  it("keeps the current entry marked when collapsed", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: toggleName }));

    expect(screen.getByRole("link", { name: "Test runs 12" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("hides the footer when collapsed instead of cutting it", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);

    expect(screen.getByText(/Swagger API reference/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: toggleName }));

    expect(screen.queryByText(/Swagger API reference/)).toBeNull();
  });

  it("gives the collapsed rail the same tab order as the panel", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);
    /* Navigation links only. The footer holds one link to the API reference,
       and the footer hides on the rail by design — the rail is too narrow for
       the version line, and a cut string reads wrong (sidebar.tsx). That link
       opens a new tab, so it is the one link with a `target`. */
    const order = (): string[] =>
      screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("target") === null)
        .map((link) => link.getAttribute("href") ?? "");
    const expanded = order();

    await user.click(screen.getByRole("button", { name: toggleName }));

    expect(order()).toEqual(expanded);
  });

  it("brings the stored state back after a remount", async () => {
    const user = userEvent.setup();
    const first = render(<Sidebar />);
    await user.click(screen.getByRole("button", { name: toggleName }));
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
    first.unmount();

    render(<Sidebar />);

    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(hiddenFromSight("Test runs")).toBe(true);
  });
});
