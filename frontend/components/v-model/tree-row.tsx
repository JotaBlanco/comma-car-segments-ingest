"use client"

import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { TreeNode } from "@/lib/vmodel/tree"

interface TreeRowProps {
  node: TreeNode
  open: boolean
  selected: boolean
  onToggle: (nodeId: string) => void
  onSelect: (node: TreeNode) => void
}

/**
 * One line of the artifact tree.
 *
 * Deliberate, and every point below was a failure of the rejected build:
 * - padding-left grows per depth level (genuine indentation, not a uniform inset)
 * - the chevron rotates 90 degrees when open; leaves get `invisible`, never
 *   `hidden`, so labels stay aligned
 * - key dimmed, value bright
 * - count right-aligned and tabular-nums so digits line up
 * - hover is a background tint only
 * - no Card, no border, no rounded corner, no shadow, no bubble, no checkbox
 * - whitespace-nowrap: labels never wrap mid-word, the pane scrolls instead
 */
export function TreeRow({ node, open, selected, onToggle, onSelect }: TreeRowProps) {
  const handleActivate = () => {
    if (node.isLeaf) {
      onSelect(node)
    } else {
      onToggle(node.id)
    }
  }

  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-level={node.depth + 1}
      aria-selected={selected}
      aria-expanded={node.isLeaf ? undefined : open}
      data-item-id={node.itemId}
      style={{ paddingLeft: node.depth * 14 + 10 }}
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          handleActivate()
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-2 whitespace-nowrap py-[7px] pr-2.5 text-sm",
        "outline-none hover:bg-foreground/5 focus-visible:bg-foreground/5",
        selected && "bg-accent text-accent-foreground"
      )}
      title={`${node.labelKey}${node.labelValue}`}
    >
      <ChevronRight
        className={cn(
          "h-3.5 w-3.5 shrink-0 transition-transform duration-100",
          open && "rotate-90",
          node.isLeaf && "invisible"
        )}
        aria-hidden="true"
      />
      <span className="overflow-hidden text-ellipsis">
        {node.labelKey && <span className="text-muted-foreground">{node.labelKey}</span>}
        <span className={cn(!selected && "text-foreground")}>{node.labelValue}</span>
      </span>
      {node.meta && (
        <span
          className={cn(
            "ml-auto shrink-0 pl-3 text-xs tabular-nums",
            selected ? "text-accent-foreground/80" : "text-muted-foreground"
          )}
        >
          {node.meta}
        </span>
      )}
    </div>
  )
}
