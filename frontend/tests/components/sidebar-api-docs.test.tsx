/**
 * The sidebar footer links to the API's own Swagger page.
 *
 * `TM_BE_URL` names an in-cluster service, so a browser cannot open it and no
 * public API address reaches this process. `next.config.ts` therefore rewrites
 * `/docs` on this origin, and the footer points at that path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

vi.mock("@/lib/hooks", () => ({
  useHomeSummary: () => ({ data: { counts: {} } }),
  usePlanningSyncStatus: () => ({ data: { online: true } }),
}));

import { Sidebar } from "@/components/shell/sidebar";

const link = () => screen.getByRole("link", { name: /Swagger API reference/ });

describe("the sidebar API reference link", () => {
  beforeEach(() => {
    pathname = "/runs";
    localStorage.clear();
  });

  it("points at the Swagger page this origin serves", () => {
    render(<Sidebar />);
    expect(link()).toHaveAttribute("href", "/docs");
  });

  it("opens in a new tab, so the Portal frame keeps the screen", () => {
    render(<Sidebar />);
    expect(link()).toHaveAttribute("target", "_blank");
    expect(link()).toHaveAttribute("rel", "noreferrer");
    /* A screen reader must hear the new tab too, so the fact sits in the
       accessible name, not only in the `title`. The exact name also pins the
       words a person reads and the `v1` fact. */
    expect(link()).toHaveAccessibleName("Swagger API reference v1 (opens in a new tab)");
  });

  it("leaves with the footer when the rail collapses", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.click(screen.getByRole("button", { name: /Collapse sidebar/ }));
    expect(screen.queryByRole("link", { name: /Swagger API reference/ })).toBeNull();
  });
});
