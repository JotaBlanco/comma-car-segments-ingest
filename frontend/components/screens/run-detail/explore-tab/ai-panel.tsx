"use client";

/**
 * Ask AI panel (Phase 4).
 *
 * The real chat surface behind Explore's "Ask AI" mode. It renders the
 * transcript (user bubbles right, assistant left with tool cards, streamed
 * answer text and an optional "SQL behind this answer" block), a composer, and
 * suggestion chips — matching the approved Explore mockup.
 *
 * State comes from useExploreChat, which streams ndjson frames from the
 * backend. Every answer that ran SQL exposes it, with actions to Copy it, Open
 * it in the SQL editor, or hand it to Visualise (via the props the parent
 * wires to its own mode setters).
 */

import { useEffect, useRef, useState } from "react";
import { MarkdownLite } from "@/components/shared/markdown-lite";
import { Button } from "@/components/ui/button";
import { useExploreChat } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { ExploreChatMessage, ExploreChatTool } from "@/types";
import { highlightSql } from "./sql-editor";

const SUGGESTIONS = [
  "Which signal ran hottest, and when did it peak?",
  "Any signals with gaps or dropouts?",
  "Summarize what happened in this run",
] as const;

interface AiPanelProps {
  runId: string;
  /** Drop the assistant's SQL into the SQL editor and switch to SQL mode. */
  onOpenInSql: (sql: string) => void;
  /** Hand the assistant's SQL to Visualise mode. */
  onVisualise: (sql: string) => void;
}

export function AiPanel({ runId, onOpenInSql, onVisualise }: AiPanelProps) {
  const { messages, send, streaming, error } = useExploreChat(runId);
  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Keep the newest frame in view as the answer streams in.
  useEffect(() => {
    const node = transcriptRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [messages, streaming]);

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || streaming) return;
    send(text);
    setDraft("");
  };

  const onSuggestion = (text: string) => {
    if (streaming) return;
    send(text);
    setDraft("");
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-line bg-surface shadow-tm">
      <div
        ref={transcriptRef}
        role="log"
        aria-label="Ask AI conversation"
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-4 py-4"
      >
        {isEmpty ? (
          <EmptyState />
        ) : (
          messages.map((message, index) =>
            message.role === "user" ? (
              <UserBubble key={index} text={message.text} />
            ) : (
              <AssistantMessage
                key={index}
                message={message}
                thinking={streaming && index === messages.length - 1}
                onOpenInSql={onOpenInSql}
                onVisualise={onVisualise}
              />
            ),
          )
        )}

        {error !== null && (
          <div
            role="alert"
            className="rounded-md border border-red-border bg-red-bg px-3.5 py-2 text-[0.76rem] text-red"
          >
            {error}
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t border-line-2 bg-surface-2 px-4 py-3">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about this run's data…"
          aria-label="Ask about this run's data"
          disabled={streaming}
          className="h-[34px] flex-1 rounded-md border border-line bg-surface px-3 text-[0.8rem] text-ink outline-none placeholder:text-ink-3 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
        />
        <Button
          size="sm"
          className="font-semibold"
          onClick={submit}
          disabled={streaming || draft.trim().length === 0}
          aria-busy={streaming}
        >
          {streaming ? "Sending…" : "Send"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-[7px] bg-surface-2 px-4 pb-3" aria-label="Suggested questions">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSuggestion(suggestion)}
            disabled={streaming}
            className="rounded-full border border-line bg-surface px-3 py-1 text-[0.72rem] font-semibold text-ink-2 transition-colors hover:border-accent-soft-border hover:bg-accent-soft hover:text-primary disabled:opacity-60"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <span
        aria-hidden
        className="grid size-9 place-items-center rounded-full bg-accent-soft text-primary"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" />
        </svg>
      </span>
      <p className="text-[0.82rem] font-semibold text-ink">Ask in plain language</p>
      <p className="max-w-sm text-[0.76rem] text-ink-3">
        Every answer shows the SQL it ran. The assistant reads this run&apos;s data only — it never
        writes, and never leaves this run&apos;s scope. Try a suggestion below to start.
      </p>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="self-end max-w-[70%] whitespace-pre-wrap rounded-[10px_10px_2px_10px] border border-accent-soft-border bg-accent-soft px-3.5 py-2 text-[0.82rem] text-ink">
      {text}
    </div>
  );
}

interface AssistantMessageProps {
  message: ExploreChatMessage;
  thinking: boolean;
  onOpenInSql: (sql: string) => void;
  onVisualise: (sql: string) => void;
}

function AssistantMessage({ message, thinking, onOpenInSql, onVisualise }: AssistantMessageProps) {
  const tools = message.tools ?? [];
  const showThinking = thinking && message.text.length === 0;

  return (
    <div className="flex max-w-[88%] flex-col gap-2.5">
      {tools.map((tool) => (
        <ToolCard key={tool.toolCallId} tool={tool} />
      ))}

      {message.text.length > 0 && (
        <div className="text-[0.84rem] text-ink">
          <MarkdownLite text={message.text} />
        </div>
      )}

      {showThinking && <ThinkingIndicator />}

      {message.sql !== undefined && (
        <SqlBlock sql={message.sql} onOpenInSql={onOpenInSql} onVisualise={onVisualise} />
      )}
    </div>
  );
}

function ToolCard({ tool }: { tool: ExploreChatTool }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-line bg-surface-2 px-3 py-[7px] text-[0.74rem] text-ink-2">
      {tool.running ? (
        <span
          aria-hidden
          className="size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-transparent"
        />
      ) : (
        <span aria-hidden className="font-bold" style={{ color: tool.isError ? "var(--red)" : "var(--green)" }}>
          {tool.isError ? "✕" : "✓"}
        </span>
      )}
      <span className="font-semibold text-ink">{tool.name}</span>
      {tool.meta !== null && (
        <span className="font-mono text-[0.68rem] text-ink-3">{tool.meta}</span>
      )}
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-[0.76rem] text-ink-3" aria-label="Assistant is thinking">
      <span className="flex gap-1" aria-hidden>
        <span className="size-1.5 animate-bounce rounded-full bg-ink-3 [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-ink-3 [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-ink-3" />
      </span>
      Thinking…
    </div>
  );
}

interface SqlBlockProps {
  sql: string;
  onOpenInSql: (sql: string) => void;
  onVisualise: (sql: string) => void;
}

function SqlBlock({ sql, onOpenInSql, onVisualise }: SqlBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(sql).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // Clipboard blocked — leave the label unchanged.
      },
    );
  };

  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-2 border-b border-line-2 bg-surface-2 px-3 py-[7px] text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-ink-3">
        SQL behind this answer
        <span className="ml-auto flex gap-1 normal-case tracking-normal">
          <SqlAction label={copied ? "Copied" : "Copy"} onClick={copy} />
          <SqlAction label="Open in SQL editor" onClick={() => onOpenInSql(sql)} />
          <SqlAction label="Visualise" onClick={() => onVisualise(sql)} />
        </span>
      </div>
      <pre className="overflow-x-auto px-3.5 py-2.5 font-mono text-[0.72rem] leading-[1.65] text-ink">
        {highlightSql(sql)}
      </pre>
    </div>
  );
}

function SqlAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-[4px] px-2 py-0.5 text-[0.72rem] font-semibold text-primary transition-colors hover:bg-accent-soft",
      )}
    >
      {label}
    </button>
  );
}
