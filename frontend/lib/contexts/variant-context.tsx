"use client"

import { createContext, useCallback, useContext, useEffect, useState } from "react"

export const VARIANTS = ["default", "focus", "console", "editorial", "neon-max"] as const
export type Variant = (typeof VARIANTS)[number]

export const VARIANT_LABELS: Record<Variant, string> = {
  default: "Default",
  focus: "Focus",
  console: "Console",
  editorial: "Editorial",
  "neon-max": "Neon Max",
}

const STORAGE_KEY = "tm-design-variant"

interface VariantContextValue {
  variant: Variant
  setVariant: (v: Variant) => void
}

const VariantContext = createContext<VariantContextValue | null>(null)

export function VariantProvider({ children }: { children: React.ReactNode }) {
  const [variant, setVariantState] = useState<Variant>("default")
  // Whether the stored value has been read yet. Without this the choice did not
  // survive a reload: the apply effect below runs on first mount holding the
  // initial "default", writes it to storage, and React's development double-mount
  // then re-runs the read effect against the value that write had just clobbered.
  // Persisting only after the read makes the two effects order-independent.
  const [hydrated, setHydrated] = useState(false)

  // Read persisted variant on mount. localStorage is unavailable during SSR.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && (VARIANTS as readonly string[]).includes(stored)) {
      setVariantState(stored as Variant)
    }
    setHydrated(true)
  }, [])

  // Apply data-variant to <html> so the CSS selectors in globals.css fire.
  // Removing the attribute restores the default look with zero side effects.
  useEffect(() => {
    if (variant === "default") {
      document.documentElement.removeAttribute("data-variant")
    } else {
      document.documentElement.setAttribute("data-variant", variant)
    }
    if (hydrated) {
      localStorage.setItem(STORAGE_KEY, variant)
    }
  }, [variant, hydrated])

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
  return useContext(VariantContext) ?? { variant: "default", setVariant: () => {} }
}
