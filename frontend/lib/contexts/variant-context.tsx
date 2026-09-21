"use client"

import { createContext, useCallback, useContext, useEffect, useState } from "react"

export const VARIANTS = ["common", "editorial", "showcase"] as const
export type Variant = (typeof VARIANTS)[number]

export const VARIANT_LABELS: Record<Variant, string> = {
  common: "Common",
  editorial: "Editorial",
  showcase: "Showcase",
}

const STORAGE_KEY = "tm-design-variant"

/** Applied when nothing is stored. "common" is the original look, not this. */
export const DEFAULT_VARIANT: Variant = "editorial"

interface VariantContextValue {
  variant: Variant
  setVariant: (v: Variant) => void
}

const VariantContext = createContext<VariantContextValue | null>(null)

export function VariantProvider({ children }: { children: React.ReactNode }) {
  // Editorial is the chosen look, so it is what an unconfigured browser gets.
  // "common" is the layout the app had before any of this and stays selectable to
  // compare against, which is why the initial value is not it.
  const [variant, setVariantState] = useState<Variant>(DEFAULT_VARIANT)

  // Read persisted variant on mount. localStorage is unavailable during SSR.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && (VARIANTS as readonly string[]).includes(stored)) {
      setVariantState(stored as Variant)
    }
  }, [])

  // Apply data-variant to <html> so the CSS selectors in globals.css fire.
  // Removing the attribute restores the default look with zero side effects.
  useEffect(() => {
    // "common" is the absence of an override, so it removes the attribute rather
    // than setting one - the original look needs no rules of its own.
    if (variant === "common") {
      document.documentElement.removeAttribute("data-variant")
    } else {
      document.documentElement.setAttribute("data-variant", variant)
    }
    localStorage.setItem(STORAGE_KEY, variant)
  }, [variant])

  const setVariant = useCallback((v: Variant) => {
    setVariantState(v)
  }, [])

  return (
    <VariantContext.Provider value={{ variant, setVariant }}>
      {children}
    </VariantContext.Provider>
  )
}

/**
 * Returns the current design variant and a setter. Falls back to the default
 * when called outside the provider (e.g. during SSR) rather than throwing.
 */
export function useVariant(): VariantContextValue {
  return useContext(VariantContext) ?? { variant: DEFAULT_VARIANT, setVariant: () => {} }
}
