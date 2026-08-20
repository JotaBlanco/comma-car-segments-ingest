"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { TreeRow } from "./tree-row"
import {
  ancestorIdsForItem,
  defaultExpandedIds,
  visibleRows,
  type TreeNode,
} from "@/lib/vmodel/tree"

interface ItemTreeProps {
  root: TreeNode
  /** `?select=` target - the leaf itemId that should be selected. */
  selectedItemId: string | null
  onSelectItem: (itemId: string) => void
  /** True when a filter is pruning the tree; drives default expansion. */
  filterActive: boolean
  /**
   * Open the group levels on first render even with no filter active. Off by
   * default, because a register of 111 requirements needs its chapters closed;
   * the Test Run tree turns it on because its three status groups would
   * otherwise hide every run behind a click.
   */
  expandGroups?: boolean
  /** Rendered instead of the tree when there is nothing to show. */
  emptyMessage?: string
  /**
   * Section heading above the tree, e.g. "Requirements". Rendered uppercase and
   * letter-spaced, after the Lakehouse "TABLES & PARTITIONS" header, so the pane
   * names itself when the tree is scrolled. Omitted when absent.
   */
  title?: string
}

/**
 * The artifact tree: `project -> feature -> chapter -> items`.
 *
 * Expansion state lives here, seeded from `defaultExpandedIds` (project and
 * feature always open; group levels open only when a filter is active) and
 * re-seeded whenever the filter is switched on or off. Manual toggles survive
 * until then.
 */
export function ItemTree({
  root,
  selectedItemId,
  onSelectItem,
  filterActive,
  expandGroups = false,
  emptyMessage = "No items match the current filter.",
  title,
}: ItemTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    defaultExpandedIds(root, filterActive || expandGroups)
  )
  const containerRef = useRef<HTMLDivElement>(null)

  // Re-seed expansion when the filter is toggled on or off, not on every keystroke.
  useEffect(() => {
    setExpanded(defaultExpandedIds(root, filterActive || expandGroups))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterActive, expandGroups])

  // Expand the path to the deep-linked / selected leaf and scroll it into view.
  useEffect(() => {
    if (!selectedItemId) return

    const ancestors = ancestorIdsForItem(root, selectedItemId)
    if (ancestors.length > 0) {
      setExpanded((prev) => {
        const missing = ancestors.filter((id) => !prev.has(id))
        if (missing.length === 0) return prev
        const next = new Set(prev)
        for (const id of missing) next.add(id)
        return next
      })
    }

    const frame = window.requestAnimationFrame(() => {
      const target = containerRef.current?.querySelector<HTMLElement>(
        `[data-item-id="${CSS.escape(selectedItemId)}"]`
      )
      target?.scrollIntoView({ block: "nearest" })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selectedItemId, root])

  const toggle = useCallback((nodeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])

  const rows = useMemo(() => visibleRows(root, expanded), [root, expanded])

  // Only the fixed project/feature levels present => nothing matched.
  const hasItems = root.children.some((feature) => feature.children.length > 0)

  return (
    <div ref={containerRef} className="w-full">
      {title && (
        <p className="sticky top-0 z-10 bg-background/95 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-foreground backdrop-blur">
          {title}
        </p>
      )}
      <div role="tree" aria-label="Artifact tree">
      {rows.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          open={expanded.has(node.id)}
          selected={Boolean(node.isLeaf && node.itemId && node.itemId === selectedItemId)}
          onToggle={toggle}
          onSelect={(target) => target.itemId && onSelectItem(target.itemId)}
        />
      ))}
      </div>
      {!hasItems && (
        <p className="px-3 py-4 text-sm text-muted-foreground">{emptyMessage}</p>
      )}
    </div>
  )
}
