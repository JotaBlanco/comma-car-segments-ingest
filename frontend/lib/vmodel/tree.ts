/**
 * Pure tree construction for the V-model explorer - no React, no DOM.
 *
 * Shape is always `project -> feature -> <levels...> -> items`. The project and
 * feature levels are fixed constants (see ./constants) and are never inlined in a
 * view. Everything below them is driven by the `levels` option, so the same
 * builder serves every stage page.
 */

import { VMODEL_FEATURE, VMODEL_PROJECT } from "./constants"

export interface TreeNode {
  /** Stable path id, e.g. "QuixPlatformVehicle/ACC/Performance". */
  id: string
  /**
   * The kind of thing this node is - for a group level, the field it groups by.
   * Rendered as a pill after the label, not as a prefix. Empty on leaves and on
   * the project / feature roots, where the value already names itself.
   */
  labelKey: string
  /** The node's own name. */
  labelValue: string
  /** Right-aligned meta string: a count for groups, version/revision for leaves. */
  meta: string
  depth: number
  isLeaf: boolean
  children: TreeNode[]
  /** Present on leaves only: the item this row represents. */
  itemId?: string
}

export type TreeItem = Record<string, unknown>

export interface BuildTreeOptions<T extends TreeItem> {
  /** Field names to group by, below the fixed project/feature levels. */
  levels: string[]
  /** Stable id of a leaf - the value used by the `?select=` deep link. */
  leafId: (item: T) => string
  /** Leaf label; `key` renders dimmed, `value` renders bright. */
  leafLabel: (item: T) => { key: string; value: string }
  /** Leaf meta, right-aligned, e.g. "rev 2.0 · v0003". */
  leafMeta: (item: T) => string
  /**
   * Explicit ordering for a level's group values. Anything not listed sorts
   * alphabetically after the listed values.
   */
  levelOrder?: Record<string, readonly string[]>
  /**
   * Leaf ordering inside a group. Omit it and leaves sort by their label, which
   * is right for an id-per-row register; the Test Run tree passes a comparator
   * because a run register reads newest-first.
   */
  leafCompare?: (a: T, b: T) => number
}

const MISSING_GROUP = "(none)"

function groupValue(item: TreeItem, field: string): string {
  const raw = item[field]
  if (raw === null || raw === undefined || raw === "") return MISSING_GROUP
  if (Array.isArray(raw)) return raw.length > 0 ? String(raw[0]) : MISSING_GROUP
  return String(raw)
}

function orderComparator(order?: readonly string[]) {
  return (a: string, b: string): number => {
    if (order) {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1
        if (ib === -1) return -1
        return ia - ib
      }
    }
    return a.localeCompare(b)
  }
}

/**
 * Build the tree from `items` (the filtered set) while reporting group counts
 * against `allItems` (the unfiltered set).
 *
 * A group node's meta reads "7 of 12" when a filter is active and "12" when it is
 * not, so the user can see what the filter removed instead of wondering where the
 * rows went. Groups with zero matching descendants are pruned entirely.
 */
export function buildTree<T extends TreeItem>(
  items: T[],
  allItems: T[],
  options: BuildTreeOptions<T>
): TreeNode {
  const filterActive = allItems.length !== items.length

  // Counts over the unfiltered set, keyed by the same path ids the tree uses.
  const totals = new Map<string, number>()
  for (const item of allItems) {
    let path = `${VMODEL_PROJECT}/${VMODEL_FEATURE}`
    totals.set(path, (totals.get(path) ?? 0) + 1)
    for (const level of options.levels) {
      path = `${path}/${groupValue(item, level)}`
      totals.set(path, (totals.get(path) ?? 0) + 1)
    }
  }

  function metaFor(pathId: string, shown: number): string {
    const total = totals.get(pathId) ?? shown
    return filterActive && total !== shown ? `${shown} of ${total}` : String(total)
  }

  function build(levelIndex: number, pathId: string, scoped: T[], depth: number): TreeNode[] {
    if (levelIndex >= options.levels.length) {
      const ordered = options.leafCompare
        ? [...scoped].sort(options.leafCompare)
        : scoped
      const leaves = ordered.map<TreeNode>((item) => {
        const label = options.leafLabel(item)
        return {
          id: `${pathId}/${options.leafId(item)}`,
          labelKey: label.key,
          labelValue: label.value,
          meta: options.leafMeta(item),
          depth,
          isLeaf: true,
          children: [],
          itemId: options.leafId(item),
        }
      })
      // A caller-supplied comparator has already decided the order.
      return options.leafCompare
        ? leaves
        : leaves.sort((a, b) =>
            `${a.labelKey}${a.labelValue}`.localeCompare(`${b.labelKey}${b.labelValue}`)
          )
    }

    const field = options.levels[levelIndex]
    const buckets = new Map<string, T[]>()
    for (const item of scoped) {
      const value = groupValue(item, field)
      const bucket = buckets.get(value)
      if (bucket) {
        bucket.push(item)
      } else {
        buckets.set(value, [item])
      }
    }

    return Array.from(buckets.keys())
      .sort(orderComparator(options.levelOrder?.[field]))
      .map<TreeNode>((value) => {
        const childPath = `${pathId}/${value}`
        const scopedChildren = buckets.get(value) ?? []
        return {
          id: childPath,
          // The field this level groups by, shown as a pill next to the value the way
          // the Lakehouse tree tags a partition folder with `platform` / `device`.
          labelKey: field.replace(/_/g, " "),
          labelValue: value,
          meta: metaFor(childPath, scopedChildren.length),
          depth,
          isLeaf: false,
          children: build(levelIndex + 1, childPath, scopedChildren, depth + 1),
        }
      })
      // Prune: a group with no matching descendants is removed entirely.
      .filter((node) => node.children.length > 0)
  }

  const featurePath = `${VMODEL_PROJECT}/${VMODEL_FEATURE}`
  const featureNode: TreeNode = {
    id: featurePath,
    labelKey: "",
    labelValue: VMODEL_FEATURE,
    meta: metaFor(featurePath, items.length),
    depth: 1,
    isLeaf: false,
    children: build(0, featurePath, items, 2),
  }

  return {
    id: VMODEL_PROJECT,
    labelKey: "",
    labelValue: VMODEL_PROJECT,
    meta: metaFor(featurePath, items.length),
    depth: 0,
    isLeaf: false,
    children: [featureNode],
  }
}

/**
 * Ids that start expanded: project and feature always; the group levels below them
 * open when a filter is active (so matches are immediately visible) and collapsed
 * when it is not.
 */
export function defaultExpandedIds(root: TreeNode, filterActive: boolean): Set<string> {
  const expanded = new Set<string>([root.id])
  for (const feature of root.children) {
    expanded.add(feature.id)
    if (filterActive) {
      for (const group of feature.children) {
        collectGroupIds(group, expanded)
      }
    }
  }
  return expanded
}

function collectGroupIds(node: TreeNode, into: Set<string>): void {
  if (node.isLeaf) return
  into.add(node.id)
  for (const child of node.children) {
    collectGroupIds(child, into)
  }
}

/** Every ancestor node id on the path to the leaf whose `itemId` matches. */
export function ancestorIdsForItem(root: TreeNode, itemId: string): string[] {
  const path: string[] = []

  function walk(node: TreeNode, trail: string[]): boolean {
    if (node.isLeaf) {
      if (node.itemId === itemId) {
        path.push(...trail)
        return true
      }
      return false
    }
    return node.children.some((child) => walk(child, [...trail, node.id]))
  }

  walk(root, [])
  return path
}

/** Flatten to the rows that are actually visible given the expanded set. */
export function visibleRows(root: TreeNode, expanded: Set<string>): TreeNode[] {
  const rows: TreeNode[] = []

  function walk(node: TreeNode): void {
    rows.push(node)
    if (!node.isLeaf && expanded.has(node.id)) {
      for (const child of node.children) {
        walk(child)
      }
    }
  }

  walk(root)
  return rows
}
