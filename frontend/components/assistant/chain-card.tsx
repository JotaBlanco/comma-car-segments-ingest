/**
 * Lineage chain answer (AS-5) — one row per node: uppercase kind, mono id
 * (linked when the node has a screen), quiet note on the right. This is the
 * WO → definition → run → results moat drawn as the record shows it.
 */

import Link from "next/link";
import type { AssistantChainKind, AssistantChainNode } from "@/types";
import { isAppRelativeUrl } from "./app-url";

const KIND_LABELS: Record<AssistantChainKind, string> = {
  work_order: "Work order",
  definition: "Definition",
  run: "Run",
  files: "Files",
  results: "Results",
};

function NodeId({ node }: { node: AssistantChainNode }) {
  const className = "font-mono text-[0.76rem] font-semibold";
  if (node.url !== null && isAppRelativeUrl(node.url)) {
    return (
      <Link href={node.url} className={`${className} text-primary hover:underline`}>
        {node.id}
      </Link>
    );
  }
  return <span className={`${className} text-ink`}>{node.id}</span>;
}

export function ChainCard({ nodes }: { nodes: AssistantChainNode[] }) {
  return (
    <div
      data-testid="assistant-chain"
      className="flex flex-col rounded-md border border-line bg-surface shadow-tm"
    >
      {nodes.map((node, index) => (
        <div
          key={`${node.kind}:${node.id}:${index}`}
          className="flex items-center gap-2 border-t border-line-2 px-3 py-[7px] text-[0.78rem] first:border-t-0"
        >
          <span className="w-[74px] flex-none text-[0.62rem] font-semibold tracking-[0.07em] text-ink-3 uppercase">
            {KIND_LABELS[node.kind]}
          </span>
          <NodeId node={node} />
          <span className="ml-auto text-[0.7rem] whitespace-nowrap text-ink-3">{node.label}</span>
        </div>
      ))}
    </div>
  );
}
