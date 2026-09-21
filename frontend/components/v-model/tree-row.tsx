"use client"

import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react"
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
 * One line of the artifact tree, styled after the Tables & Partitions tree in the
 * Quix Lakehouse UI so the two products read as one family.
 *
 * Taken from that reference:
 * - a type icon between the chevron and the label: an amber folder for a grouping
 *   level, a blue document for a leaf. Colour carries the type, so depth alone is
 *   not the only cue.
 * - the level's kind (`feature`, `chapter`, ...) is a small grey pill after the
 *   label, the way the Lakehouse tags a partition column with `platform` / `device`.
 *   It used to be a dim text prefix, which read as part of the name.
 *
 * Kept from the previous build, each point having been a failure of the one before:
 * - padding-left grows per depth level (genuine indentation, not a uniform inset)
 * - the chevron rotates 90 degrees when open; leaves get `invisible`, never
 *   `hidden`, so labels stay aligned
 * - count right-aligned and tabular-nums so digits line up
 * - hover is a background tint only
 * - no Card, no border, no rounded corner, no shadow, no bubble, no checkbox
 * - whitespace-nowrap: labels never wrap mid-word; the name truncates with an
 *   ellipsis so the kind pill and the meta column stay put
 */
export function TreeRow({ node, open, selected, onToggle, onSelect }: TreeRowProps) {
  const handleActivate = () => {
    if (node.isLeaf) {
      onSelect(node)
    } else {
      onToggle(node.id)
    }
  }

  const TypeIcon = node.isLeaf ? FileText : open ? FolderOpen : Folder

  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-level={node.depth + 1}
      aria-selected={selected}
      aria-expanded={node.isLeaf ? undefined : open}
      data-item-id={node.itemId}
      style={{ paddingLeft: node.depth * 11 + 8 }}
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          handleActivate()
        }
      }}
      className={cn(
        "group relative flex min-w-0 cursor-pointer items-center gap-1.5 whitespace-nowrap py-[7px] pr-2 text-sm",
        "outline-none hover:bg-foreground/5 focus-visible:bg-foreground/5",
        // The selected row is marked by a neon edge and tint rather than a filled
        // block, so a long register does not turn into a wall of solid colour.
        selected &&
          "bg-neon/10 before:absolute before:left-0 before:top-0 before:h-full before:w-0.5 before:bg-neon"
      )}
      title={node.labelKey ? `${node.labelValue} (${node.labelKey})` : node.labelValue}
    >
      <ChevronRight
        className={cn(
          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-100",
          open && "rotate-90",
          node.isLeaf && "invisible"
        )}
        aria-hidden="true"
      />
      <TypeIcon
        className={cn(
          "h-4 w-4 shrink-0",
          node.isLeaf ? "text-neon-alt" : "text-amber-500 dark:text-amber-400"
        )}
        aria-hidden="true"
      />
      {/* The name never yields - it is the requirement id, the one thing the row
          exists to show. Truncating it produced a column of "ACC-SYS-PRF-...". */}
      <span className="shrink-0 text-foreground">{node.labelValue}</span>
      {node.labelKey && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {node.labelKey}
        </span>
      )}
      {node.meta && (
        <span
          className={cn(
            // The meta is what gives way when the pane is narrow, not the id.
            "ml-auto min-w-0 truncate pl-3 text-xs tabular-nums",
            selected ? "text-foreground/70" : "text-muted-foreground"
          )}
        >
          {node.meta}
        </span>
      )}
    </div>
  )
}
