/**
 * AssistantPanel — the registry assistant column (AS-4/AS-5).
 *
 * The streaming client and status probe are faked so the panel's behavior is
 * what's under test:
 *  - the empty state shows once status confirms and before any turn;
 *  - suggestion chips fill the composer (they do not send);
 *  - sending the sensor question renders the user turn, the trace line, the
 *    three hit cards and the deep link from the shared mock script;
 *  - an error frame surfaces as the panel's error state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { AssistantProvider } from "@/components/assistant/assistant-provider";
import { SENSOR_FRAMES } from "@/lib/mock/assistant-script";
import type { AssistantFrame } from "@/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const streamAssistantChat = vi.fn();

vi.mock("@/lib/api/assistant", () => ({
  getAssistantStatus: vi.fn(async () => ({ enabled: true, reachable: true })),
  streamAssistantChat: (options: unknown) => streamAssistantChat(options),
}));

beforeEach(() => {
  streamAssistantChat.mockReset();
  // Default turn: replay the shared sensor script, exactly as the mock route
  // serves it — the served frames and the expected frames cannot drift.
  streamAssistantChat.mockImplementation(
    async ({ onFrame }: { onFrame: (frame: AssistantFrame) => void }) => {
      for (const frame of SENSOR_FRAMES) onFrame(frame);
    },
  );
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AssistantProvider defaultOpen>
        <AssistantPanel />
      </AssistantProvider>
    </QueryClientProvider>,
  );
}

const composer = () =>
  screen.getByLabelText("Ask about runs, files, signals, work orders") as HTMLInputElement;

async function ask(question: string) {
  fireEvent.change(composer(), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("AssistantPanel", () => {
  it("shows the trust contract and the empty state once status confirms", async () => {
    renderPanel();
    expect(await screen.findByText("Reads the registry. Never edits.")).toBeInTheDocument();
    expect(screen.getByText("Ask the registry")).toBeInTheDocument();
  });

  it("suggestion chips fill the composer without sending", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "What arrived today?" }));
    expect(composer().value).toBe("What arrived today?");
    expect(streamAssistantChat).not.toHaveBeenCalled();
  });

  it("renders the sensor turn: user block, trace, three hits, deep link", async () => {
    renderPanel();
    await screen.findByText("Reads the registry. Never edits.");
    await ask("Which tests failed because of sensor issues on EX90 in the last month?");

    expect(
      await screen.findByText("Which tests failed because of sensor issues on EX90 in the last month?"),
    ).toBeInTheDocument();

    // The collapsed mono trace line, built from the two tool cards.
    expect(await screen.findByText(/invalid-flags · journal/)).toBeInTheDocument();

    expect(await screen.findAllByTestId("assistant-hit")).toHaveLength(3);
    expect(screen.getByText("TAS-88012")).toBeInTheDocument();

    const deeplink = screen.getByTestId("assistant-deeplink");
    expect(deeplink).toHaveAttribute("href", "/runs?status=invalid&project=EX90&q=sensor");
  });

  it("surfaces an error frame as the panel's error state", async () => {
    streamAssistantChat.mockImplementation(
      async ({ onFrame }: { onFrame: (frame: AssistantFrame) => void }) => {
        onFrame({ type: "error", session_id: "s1", message: "budget exhausted" });
      },
    );
    renderPanel();
    await screen.findByText("Reads the registry. Never edits.");
    await ask("anything");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("budget exhausted");
  });
});
