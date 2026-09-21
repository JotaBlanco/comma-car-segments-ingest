"use client"

import { MainLayout } from "@/components/layout/main-layout"

interface StagePlaceholderProps {
  title: string
  description: string
}

/**
 * Temporary landing surface for a V-model stage whose explorer has not been
 * built yet (Phase 3). It exists so every sidebar entry routes to a real page
 * instead of a 404, and it says plainly that the stage is not implemented -
 * it never renders fabricated content.
 */
export function StagePlaceholder({ title, description }: StagePlaceholderProps) {
  return (
    <MainLayout noPadding>
      <div className="flex h-[calc(100vh-4rem)] flex-col">
        <div className="flex h-14 shrink-0 items-center border-b px-4">
          <h1 className="text-lg font-semibold">{title}</h1>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-md text-center">
            <p className="text-sm font-medium">{title} is not implemented yet</p>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
      </div>
    </MainLayout>
  )
}
