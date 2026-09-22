/**
 * The Ask trigger prints the shortcut of the platform a person is using.
 *
 * The search box one control away already does this through `Kbd`. A fixed
 * "⌘J" told a Windows reader to press a key their keyboard does not have,
 * while the same bar showed "Ctrl K" beside it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AskTrigger } from "@/components/assistant/ask-trigger";
import { AssistantProvider } from "@/components/assistant/assistant-provider";

vi.mock("@/lib/api/assistant", () => ({
  getAssistantStatus: vi.fn(async () => ({ enabled: true, reachable: true })),
  streamAssistantChat: vi.fn(),
}));

const realPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");

function setPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", { value, configurable: true });
  /* `Kbd` reads `navigator.userAgentData.platform` first, so a stale value
     there would beat the one this test sets. */
  Object.defineProperty(navigator, "userAgentData", {
    value: { platform: value },
    configurable: true,
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <AssistantProvider>{children}</AssistantProvider>
    </QueryClientProvider>
  );
}

const trigger = () => screen.findByRole("button", { name: /Ask/ });

describe("the Ask shortcut hint", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    if (realPlatform) Object.defineProperty(navigator, "platform", realPlatform);
    Reflect.deleteProperty(navigator, "userAgentData");
  });

  it("reads Ctrl J on Windows, like the search box beside it", async () => {
    setPlatform("Win32");
    render(<AskTrigger />, { wrapper });
    expect(await trigger()).toHaveTextContent("Ctrl J");
  });

  it("reads the Command glyph on a Mac", async () => {
    setPlatform("MacIntel");
    render(<AskTrigger />, { wrapper });
    expect(await trigger()).toHaveTextContent("⌘J");
  });

  it("never prints the Command glyph on Windows", async () => {
    setPlatform("Win32");
    render(<AskTrigger />, { wrapper });
    expect((await trigger()).textContent).not.toContain("⌘");
  });
});
