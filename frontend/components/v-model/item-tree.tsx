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
  /** Rendered instead of the tree when there is nothing to show. */
  emptyMessage?: string
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
  emptyMessage = "No items match the current filter.",
}: ItemTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    defaultExpandedIds(root, filterActive)
  )
  const containerRef = useRef<HTMLDivElement>(null)

  // Re-seed expansion when the filter is toggled on or off, not on every keystroke.
  useEffect(() => {
    setExpanded(defaultExpandedIds(root, filterActive))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterActive])

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
    <div ref={containerRef} role="tree" aria-label="Artifact tree" className="min-w-max">
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
      {!hasItems && (
        <p className="px-3 py-4 text-sm text-muted-foreground">{emptyMessage}</p>
      )}
    </div>
  )
}
