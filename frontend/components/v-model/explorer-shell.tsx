"use client"

import { useState } from "react"
import { MainLayout } from "@/components/layout/main-layout"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ExplorerToolbar } from "./explorer-toolbar"

interface ExplorerShellProps {
  title: string
  total: number
  shown: number
  /**
   * Filter builder + tree. Rendered in the left pane and, below `lg`, inside a
   * dialog. `onItemSelected` closes that dialog and is a no-op on the desktop pane.
   */
  browser: (ctx: { onItemSelected: () => void }) => React.ReactNode
  /** The detail pane content. */
  children: React.ReactNode
  onAdd?: () => void
  onUpload?: () => void
}

/**
 * The master/detail explorer shell shared by every V-model stage page.
 *
 * Layout rules that are not negotiable - each one is a failure of the rejected
 * Streamlit build:
 * - `min-h-0` on both flex children, otherwise the panes will not scroll
 *   independently and the page grows a second scrollbar.
 * - `min-w-0` on the detail section, otherwise a long unbroken string forces the
 *   tree pane to shrink and the controls degrade to one character per line.
 * - The tree pane is a fixed `w-80` (320px), never a fraction. A fractional column
 *   is what produced the 175px tree that broke "Functional-HMI" mid-word.
 * - Below `lg` the tree pane is hidden and the toolbar's Browse button opens the
 *   same browser inside a dialog. Tailwind's own breakpoint, nothing hand-rolled.
 *
 * `h-[calc(100vh-4rem)]` subtracts the existing sticky h-16 header.
 */
function noop(): void {
  /* desktop pane has no dialog to close */
}

export function ExplorerShell({
  title,
  total,
  shown,
  browser,
  children,
  onAdd,
  onUpload,
}: ExplorerShellProps) {
  const [browseOpen, setBrowseOpen] = useState(false)

  return (
    <MainLayout noPadding>
      <div className="flex h-[calc(100vh-4rem)] flex-col">
        <ExplorerToolbar
          title={title}
          total={total}
          shown={shown}
          onBrowse={() => setBrowseOpen(true)}
          onAdd={onAdd}
          onUpload={onUpload}
        />

        <div className="flex min-h-0 flex-1">
          {/* Region B - the browser: filter above, tree below */}
          <aside className="hidden w-80 shrink-0 flex-col border-r lg:flex">
            {browser({ onItemSelected: noop })}
          </aside>

          {/* Region C - the detail pane */}
          <section className="min-w-0 flex-1 overflow-y-auto">{children}</section>
        </div>
      </div>

      {/* Below lg the same browser lives in a dialog */}
      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
        <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-md">
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle className="text-base">{title}</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[70vh] flex-col">
            {browser({ onItemSelected: () => setBrowseOpen(false) })}
          </div>
        </DialogContent>
      </Dialog>
    </MainLayout>
  )
}
