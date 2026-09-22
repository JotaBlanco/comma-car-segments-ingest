"use client";

import { Fragment, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHead } from "@/components/shared/panel";
import { MonoChip } from "./chip-list";
import type { RequirementDetail } from "@/types";

const TOKEN_RE = /\{([^}]+)\}/g;

/**
 * Split `text` on its `{token}` markers and render each with the matching
 * entry of `resolved_tokens` as an inline mono chip — so a reader sees
 * WHERE substitution happened, not just the final sentence (spec §7B).
 */
function RenderedText({
  text,
  resolvedTokens,
}: {
  text: string;
  resolvedTokens: readonly { token: string; resolved: string }[];
}) {
  const byToken = new Map(resolvedTokens.map((entry) => [entry.token, entry.resolved]));
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  // `matchAll` clones the regex internally, so the shared module-level
  // `TOKEN_RE` is never mutated by this render.
  for (const match of text.matchAll(TOKEN_RE)) {
    const index = match.index;
    if (index > lastIndex) parts.push(<Fragment key={key++}>{text.slice(lastIndex, index)}</Fragment>);
    const resolved = byToken.get(match[1]);
    parts.push(
      <MonoChip key={key++} className="mx-0.5">
        {resolved ?? match[0]}
      </MonoChip>,
    );
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  return <>{parts}</>;
}

export function RequirementTextPanel({ detail }: { detail: RequirementDetail }) {
  const [showRaw, setShowRaw] = useState(false);
  const resolvedTokens = detail.resolved_tokens ?? [];
  const canToggle = detail.text_rendered !== null || resolvedTokens.length > 0;

  return (
    <Panel className="mb-3">
      <PanelHead
        title="Requirement text"
        action={
          canToggle ? (
            <Button variant="outline" size="sm" onClick={() => setShowRaw((value) => !value)}>
              {showRaw ? "Show resolved" : "Show tokens"}
            </Button>
          ) : undefined
        }
      />
      <div className="px-4 py-3.5 text-[0.85rem] leading-relaxed">
        {showRaw ? (
          detail.text
        ) : resolvedTokens.length > 0 ? (
          <RenderedText text={detail.text} resolvedTokens={resolvedTokens} />
        ) : (
          (detail.text_rendered ?? detail.text)
        )}
      </div>
    </Panel>
  );
}
