/**
 * The assistant dock's published width, and the focus-mode `inert` handover.
 *
 * The bug: on the Explore tab, clicking Ask AI appeared to do nothing. The
 * panel did open — the Explore container is `fixed … right-0 … z-30` with an
 * opaque background, and the docked panel carries no z-index, so the panel was
 * painted underneath it. The fix has the panel publish its width as
 * `--dock-w` / `--dock-left-w` and the overlay stop there, the same way both
 * already stop at the sidebar's `--sidebar-w`.
 *
 * jsdom does not paint, so stacking cannot be asserted here. What it CAN hold
 * is the contract the fix rests on: the variable the overlay reads, and the
 * class the overlay uses.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { AssistantProvider } from "@/components/assistant/assistant-provider";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/api/assistant", () => ({
  getAssistantStatus: vi.fn(async () => ({ enabled: true, reachable: true })),
  streamAssistantChat: vi.fn(async () => undefined),
}));

function renderPanel(defaultOpen: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AssistantProvider defaultOpen={defaultOpen}>
        <AssistantPanel />
      </AssistantProvider>
    </QueryClientProvider>,
  );
}

/** The panel renders only once the status probe resolves `enabled`. */
async function waitForPanel(): Promise<void> {
  // A closed panel carries aria-hidden, so it is absent from the a11y tree and
  // no role query reaches it. Wait on the element.
  await waitFor(() =>
    expect(document.querySelector('aside[aria-label="Assistant"]')).not.toBeNull(),
  );
}

function dockVar(name: "--dock-w" | "--dock-left-w"): string {
  return document.documentElement.style.getPropertyValue(name);
}

beforeEach(() => {
  document.documentElement.style.removeProperty("--dock-w");
  document.documentElement.style.removeProperty("--dock-left-w");
  delete document.documentElement.dataset.exploreFocus;
  localStorage.clear();
});

describe("assistant dock width", () => {
  it("publishes a non-zero right-dock width while open", async () => {
    renderPanel(true);
    await screen.findByRole("complementary", { name: "Assistant" });
    expect(dockVar("--dock-w")).not.toBe("0px");
    expect(dockVar("--dock-w")).toMatch(/^\d+px$/);
    // Nothing is docked on the left, so the left edge must not move.
    expect(dockVar("--dock-left-w")).toBe("0px");
  });

  it("publishes zero while closed, so the overlay reclaims the width", async () => {
    renderPanel(false);
    await waitForPanel();
    expect(dockVar("--dock-w")).toBe("0px");
    expect(dockVar("--dock-left-w")).toBe("0px");
  });

  it("drops the width back to zero when the panel closes", async () => {
    renderPanel(true);
    await screen.findByRole("complementary", { name: "Assistant" });
    expect(dockVar("--dock-w")).not.toBe("0px");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(dockVar("--dock-w")).toBe("0px");
  });

  it("refuses the meta-J shortcut while Explore focus mode is up", async () => {
    renderPanel(false);
    await waitForPanel();

    // Focus mode covers the chrome; opening behind it would leave the panel
    // unreachable but in the tab order, and desync the inert handover.
    document.documentElement.dataset.exploreFocus = "1";
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(dockVar("--dock-w")).toBe("0px");

    delete document.documentElement.dataset.exploreFocus;
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(dockVar("--dock-w")).not.toBe("0px");
  });
});

describe("the shell breakout class", () => {
  it("stops at the sidebar and at the dock, never at the viewport edge", () => {
    // `right-0` is what put the overlay over the assistant column.
    expect(SHELL_BREAKOUT_CLASS).not.toMatch(/\bright-0\b/);
    expect(SHELL_BREAKOUT_CLASS).toContain("right-(--dock-w)");
    expect(SHELL_BREAKOUT_CLASS).toContain("--sidebar-w");
    expect(SHELL_BREAKOUT_CLASS).toContain("--dock-left-w");
  });

  it("eases its edges like the panel eases its width, so the two stay together", () => {
    expect(SHELL_BREAKOUT_CLASS).toContain("transition-[left,right]");
    expect(SHELL_BREAKOUT_CLASS).toContain("duration-[280ms]");
  });
});
