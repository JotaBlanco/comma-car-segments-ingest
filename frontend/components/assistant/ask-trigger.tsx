"use client";

/**
 * Topbar "Ask" trigger (AS-4) — same idiom as the search box: a quiet
 * bordered control with a kbd hint, accent-soft only while the panel is open.
 *
 * Hidden entirely until GET /assistant/status confirms the feature (plan
 * §5.2: hide-until-status-confirms) — including while the status query is
 * still loading, so the topbar never flashes a control that then vanishes.
 */

import { MessageCircle } from "lucide-react";
import { Kbd } from "@/components/shared/kbd";
import { useAssistantStatus } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useAssistantPanel } from "./assistant-provider";

export function AskTrigger() {
  const { open, toggle } = useAssistantPanel();
  const { data: status } = useAssistantStatus();

  if (status?.enabled !== true) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      title="Ask the registry"
      aria-pressed={open}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-semibold transition-colors",
        open
          ? "border-accent-soft-border bg-accent-soft text-primary"
          : "border-line bg-surface-2 text-ink-2 hover:border-line-strong",
      )}
    >
      <MessageCircle
        size={14}
        strokeWidth={2}
        aria-hidden
        className={open ? "text-primary" : "text-ink-3"}
      />
      Ask
      {/* The search box beside this one already reads the platform. A fixed
          ⌘ told a Windows reader to press a key their keyboard does not have,
          while the same bar showed "Ctrl K" one control away. */}
      <Kbd keyLabel="J" />
    </button>
  );
}
