"use client";

/**
 * Turn renderers for the assistant panel (AS-5).
 *
 * A user turn is a quiet right-aligned surface-2 block — not a bubble with a
 * tail. An assistant turn stacks: the collapsed mono trace line (the audit of
 * which tools ran), the answer text (never linkified — the FE only makes
 * validated `deeplink`/`hits` frames clickable), then the structured frames.
 */

import { useState } from "react";
import { MarkdownLite } from "@/components/shared/markdown-lite";
import type { AssistantMessage, AssistantTool } from "@/types";
import { ChainCard } from "./chain-card";
import { DeeplinkButton } from "./deeplink-button";
import { HitCard } from "./hit-card";

export function UserTurn({ text }: { text: string }) {
  return (
    <div className="max-w-[88%] self-end rounded-md border border-line bg-surface-2 px-3 py-2 font-medium whitespace-pre-wrap">
      {text}
    </div>
  );
}

/**
 * The audit line: "✓ invalid-flags · journal · 3 calls". Collapsed by
 * default; expanding lists each call with its one-line result summary.
 */
function ToolTrace({ tools }: { tools: AssistantTool[] }) {
  const [expanded, setExpanded] = useState(false);
  const running = tools.some((tool) => tool.running);
  const failed = tools.some((tool) => tool.isError);
  const names = [...new Set(tools.map((tool) => tool.name))].join(" · ");

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded((previous) => !previous)}
        aria-expanded={expanded}
        className="flex items-center gap-[7px] self-start font-mono text-[0.68rem] text-ink-3 transition-colors hover:text-ink-2"
      >
        {running ? (
          <span
            aria-hidden
            className="size-2.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-transparent"
          />
        ) : (
          <span aria-hidden className={failed ? "text-red" : "text-green"}>
            {failed ? "✕" : "✓"}
          </span>
        )}
        <span>
          {names}
          <span className="text-line-strong"> · </span>
          {tools.length} {tools.length === 1 ? "call" : "calls"}
        </span>
      </button>
      {expanded && (
        <ul className="flex flex-col gap-0.5 pl-5 font-mono text-[0.66rem] text-ink-3">
          {tools.map((tool) => (
            <li key={tool.toolCallId} className="flex items-baseline gap-1.5">
              <span aria-hidden className={tool.isError ? "text-red" : "text-green"}>
                {tool.running ? "…" : tool.isError ? "✕" : "✓"}
              </span>
              <span className="text-ink-2">{tool.name}</span>
              {tool.summary !== null && <span>— {tool.summary}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-[0.74rem] text-ink-3" aria-label="Assistant is thinking">
      <span className="flex gap-1" aria-hidden>
        <span className="size-1.5 animate-bounce rounded-full bg-ink-3 [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-ink-3 [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-ink-3" />
      </span>
      Thinking…
    </div>
  );
}

interface AssistantTurnProps {
  message: AssistantMessage;
  /** True while this (trailing) turn is still streaming. */
  streaming: boolean;
}

export function AssistantTurn({ message, streaming }: AssistantTurnProps) {
  const tools = message.tools ?? [];
  const showThinking = streaming && message.text.length === 0;

  return (
    <div className="flex flex-col gap-2.5">
      {tools.length > 0 && <ToolTrace tools={tools} />}

      {message.text.length > 0 && (
        <div className="text-[0.82rem] text-ink-2">
          <MarkdownLite text={message.text} />
        </div>
      )}

      {showThinking && <ThinkingIndicator />}

      {message.hits !== undefined && message.hits.length > 0 && (
        <div>
          {message.hits.map((hit) => (
            <HitCard key={hit.run_id} hit={hit} />
          ))}
        </div>
      )}

      {message.chain !== undefined && message.chain.length > 0 && (
        <ChainCard nodes={message.chain} />
      )}

      {message.deeplink !== undefined && <DeeplinkButton deeplink={message.deeplink} />}
    </div>
  );
}
