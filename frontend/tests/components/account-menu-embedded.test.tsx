/**
 * One user, one avatar.
 *
 * The Quix Portal frames this app and already shows the signed-in person at
 * the top right of its own chrome. Our own account menu shows the same person
 * again, a few pixels below. So the menu hides itself inside a frame, and it
 * shows as before when a person opens the Test Manager on its own.
 *
 * `isEmbedded` is the stub, because jsdom runs the page in no frame. It is the
 * detector the app already had (`lib/portal/token-store.ts`), and the app
 * reuses it rather than reading the frame a second time.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "@/components/account/account-menu";
import { setPortalApiBase } from "@/lib/portal/client";

/** `vi.hoisted` runs before the mock factory, so the flag exists in time. */
const frame = vi.hoisted(() => ({ embedded: false }));

vi.mock("@/lib/portal/token-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/token-store")>();
  return { ...actual, isEmbedded: () => frame.embedded };
});

const ACCOUNT_BUTTON = /Account menu/;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  frame.embedded = false;
  // No Portal base means `portalOrigins()` names no origin, so the handshake
  // gives up at once instead of waiting out its timeout.
  setPortalApiBase(null);
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("the account menu and the Portal frame", () => {
  it("shows the account avatar when the page runs on its own", async () => {
    render(<AccountMenu />, { wrapper });
    await act(async () => {});

    expect(screen.getByRole("button", { name: ACCOUNT_BUTTON })).toBeInTheDocument();
  });

  it("shows no account avatar inside a frame, because the Portal shows the person", async () => {
    frame.embedded = true;
    render(<AccountMenu />, { wrapper });
    await act(async () => {});

    expect(screen.queryByRole("button", { name: ACCOUNT_BUTTON })).toBeNull();
  });
});
