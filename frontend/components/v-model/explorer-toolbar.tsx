"use client"

import { ListTree, Plus, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"

interface ExplorerToolbarProps {
  title: string
  /** Total items in the working set, across every version. */
  total: number
  /** Items surviving the current filter. */
  shown: number
  /** Opens the tree in a dialog below the `lg` breakpoint. */
  onBrowse: () => void
  onAdd?: () => void
  onUpload?: () => void
}

/**
 * Region D. Fixed height, always one row: nothing about Add or Upload occupies
 * vertical space when closed. Both open modal dialogs - no inline expanders and
 * no side panels, which was an explicit user rejection.
 */
export function ExplorerToolbar({
  title,
  total,
  shown,
  onBrowse,
  onAdd,
  onUpload,
}: ExplorerToolbarProps) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold leading-tight">{title}</h1>
        <p className="text-xs text-muted-foreground tabular-nums">
          {total} item{total === 1 ? "" : "s"}
          {shown !== total && <> &middot; {shown} shown</>}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="lg:hidden"
          onClick={onBrowse}
          aria-label="Browse items"
        >
          <ListTree className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Browse
        </Button>
        <Button size="sm" onClick={onAdd} disabled={!onAdd}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Add
        </Button>
        <Button size="sm" variant="outline" onClick={onUpload} disabled={!onUpload}>
          <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Upload
        </Button>
      </div>
    </div>
  )
}
