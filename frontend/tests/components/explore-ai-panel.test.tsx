/**
 * AiPanel — Ask AI chat surface (Phase 4).
 *
 * The streaming client is faked so the panel's behavior is what's under test:
 *  - the empty state shows before any turn;
 *  - sending appends the user's message;
 *  - answer_delta frames render as accumulated answer text;
 *  - "Open in SQL editor" hands the assistant's SQL back to the parent.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AiPanel } from "@/components/screens/run-detail/explore-tab/ai-panel";

const SQL = "SELECT signal, max(value) FROM test_signal_samples GROUP BY signal";

// Fake the streaming client: one turn that opens a query tool (with SQL in its
// args), streams a two-part answer, and ends.
vi.mock("@/lib/api/explore-chat", () => ({
  streamExploreChat: vi.fn(
    async ({ onFrame }: { onFrame: (frame: unknown) => void }) => {
      const session_id = "sess-1";
      onFrame({
        type: "tool_start",
        session_id,
        tool_call_id: "t2",
        tool_name: "lakeside_query",
        display_name: "Lakeside query",
      });
      onFrame({ type: "tool_args", session_id, tool_call_id: "t2", delta: JSON.stringify({ sql: SQL }) });
      onFrame({ type: "tool_result", session_id, tool_call_id: "t2", summary: "0.61 s" });
      onFrame({ type: "answer_delta", session_id, text: "Front-left " });
      onFrame({ type: "answer_delta", session_id, text: "ran hottest." });
      onFrame({ type: "done", session_id });
    },
  ),
}));

function renderPanel() {
  const onOpenInSql = vi.fn();
  const onVisualise = vi.fn();
  render(<AiPanel runId="TAS-88214" onOpenInSql={onOpenInSql} onVisualise={onVisualise} />);
  return { onOpenInSql, onVisualise };
}

async function ask(question: string) {
  const input = screen.getByLabelText("Ask about this run's data");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("AiPanel", () => {
  it("shows the empty state before any question", () => {
    renderPanel();
    expect(screen.getByText("Ask in plain language")).toBeInTheDocument();
  });

  it("appends the user's message when sent", async () => {
    renderPanel();
    await ask("Which corner ran hottest?");
    expect(await screen.findByText("Which corner ran hottest?")).toBeInTheDocument();
  });

  it("renders the accumulated answer text from answer_delta frames", async () => {
    renderPanel();
    await ask("Which corner ran hottest?");
    expect(await screen.findByText("Front-left ran hottest.")).toBeInTheDocument();
  });

  it("hands the assistant's SQL to onOpenInSql", async () => {
    const { onOpenInSql } = renderPanel();
    await ask("Which corner ran hottest?");
    const openButton = await screen.findByRole("button", { name: "Open in SQL editor" });
    fireEvent.click(openButton);
    expect(onOpenInSql).toHaveBeenCalledWith(SQL);
  });
});
