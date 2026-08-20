"use client"

import Link from "next/link"
import { Bell, Check, Search, User, X, ArrowLeft, LogOut, Moon, Palette, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useQuixAuth } from "@/lib/contexts/quix-auth-context"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useVariant, VARIANTS, VARIANT_LABELS } from "@/lib/contexts/variant-context"

interface BackLink {
  href: string
  label: string
}

interface HeaderProps {
  backLink?: BackLink
}

export function Header({ backLink }: HeaderProps) {
  const [searchInput, setSearchInput] = useState("")
  const { userName, userEmail, isEmbedded, clearTokenAndPrompt } = useQuixAuth()
  const { resolvedTheme, setTheme } = useTheme()
  const { variant, setVariant } = useVariant()
  // The resolved theme is only known in the browser, so the server cannot pick the
  // right icon. Rendering one anyway made React throw a hydration mismatch on every
  // load once a theme had been chosen, which dev surfaced as a red error toast.
  const [themeReady, setThemeReady] = useState(false)
  useEffect(() => setThemeReady(true), [])

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center border-b bg-background px-6">
      <div className="flex flex-1 items-center justify-between">
        {/* Left side - Search or Back Navigation */}
        <div className="flex flex-1 items-center space-x-4">
          {backLink ? (
            <Link href={backLink.href}>
              <Button variant="ghost" size="sm">
                <ArrowLeft className="mr-2 h-4 w-4" />
                {backLink.label}
              </Button>
            </Link>
          ) : (
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="h-9 w-full rounded-md border bg-transparent pl-10 pr-10 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary"
              />
              {searchInput && (
                <button
                  onClick={() => setSearchInput("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-muted"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right side actions */}
        <div className="flex items-center space-x-4">
          {/* Environment indicator for local development */}
          {process.env.NODE_ENV === "development" && (
            <div className="rounded-full bg-yellow-500/10 px-3 py-1 text-xs font-medium text-yellow-600">
              Local Dev
            </div>
          )}

          {/* Theme toggle - light mode existed only in Settings, so nobody found it. */}
          <button
            type="button"
            aria-label="Toggle theme"
            title={resolvedTheme === "dark" ? "Switch to light" : "Switch to dark"}
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            className="rounded-lg p-2 hover:bg-accent"
          >
            {!themeReady ? (
              <span className="block h-5 w-5" />
            ) : resolvedTheme === "dark" ? (
              <Sun className="h-5 w-5" />
            ) : (
              <Moon className="h-5 w-5" />
            )}
          </button>

          {/* Design variant picker - a local preview tool for choosing a look, not a
              feature for whoever opens the deployed app, so it is gated to development
              the same way the Local Dev badge above is. NODE_ENV is "production" in the
              deployed image, so the control simply is not rendered there; the variant
              CSS costs nothing without the data-variant attribute to trigger it. */}
          {process.env.NODE_ENV === "development" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Switch design variant"
                title="Design variant"
                className="rounded-lg p-2 hover:bg-accent"
              >
                <Palette className="h-5 w-5" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Design Variant</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {VARIANTS.map((v) => (
                <DropdownMenuItem
                  key={v}
                  onClick={() => setVariant(v)}
                  className="flex items-center justify-between"
                >
                  <span>{VARIANT_LABELS[v]}</span>
                  {v === variant && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          )}

          {/* Notifications */}
          <button className="relative rounded-lg p-2 hover:bg-accent">
            <Bell className="h-5 w-5" />
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive" />
          </button>

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center space-x-2 rounded-lg p-2 hover:bg-accent">
                <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-primary/10">
                  <User className="h-4 w-4" />
                </div>
                <div className="text-left">
                  <div className="text-sm font-medium">{userName || "User"}</div>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">{userName || "User"}</p>
                  {userEmail && (
                    <p className="text-xs leading-none text-muted-foreground">
                      {userEmail}
                    </p>
                  )}
                </div>
              </DropdownMenuLabel>
              {!isEmbedded && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={clearTokenAndPrompt}
                    className="cursor-pointer"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>Close Session</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}
