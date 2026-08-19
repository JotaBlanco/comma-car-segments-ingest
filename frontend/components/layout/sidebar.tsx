"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Home,
  FileText,
  ClipboardList,
  Code2,
  PlayCircle,
  CheckCircle2,
  Box,
  Server,
  ChevronLeft,
  Settings,
  Sliders,
  BarChart3,
  LineChart,
} from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { useSidebar } from "@/lib/contexts/sidebar-context"

interface NavItem {
  href: string
  icon: React.ElementType
  label: string
}

interface NavSection {
  /** Section heading shown when the sidebar is expanded. `null` = no heading. */
  label: string | null
  items: NavItem[]
}

/**
 * The left sidebar is the single primary navigation surface of the app.
 * There is deliberately no top navigation bar, no tab strip and no horizontal
 * breadcrumb nav anywhere in the V-model feature.
 *
 * Ordering is the V-model order (Requirements -> Test Specification ->
 * Test Implementation -> Test Run -> Test Results) and must never be re-sorted
 * alphabetically: reading the sidebar top-to-bottom is the affordance.
 *
 * `/tests` is re-scoped into the Test Run stage - there is no second run surface.
 */
const navSections: NavSection[] = [
  {
    label: null,
    items: [{ href: "/", icon: Home, label: "Home" }],
  },
  {
    label: "V-Model",
    items: [
      { href: "/requirements", icon: FileText, label: "Requirements" },
      { href: "/test-specs", icon: ClipboardList, label: "Test Specification" },
      { href: "/test-implementations", icon: Code2, label: "Test Implementation" },
      { href: "/tests", icon: PlayCircle, label: "Test Run" },
      { href: "/test-results", icon: CheckCircle2, label: "Test Results" },
    ],
  },
  {
    label: "Assets",
    items: [
      { href: "/devices", icon: Box, label: "Devices" },
      { href: "/environments", icon: Server, label: "Environments" },
    ],
  },
  {
    label: "Integrations",
    items: [
      { href: "/config-manager", icon: Sliders, label: "Configurations" },
      { href: "/measurements", icon: BarChart3, label: "Measurements" },
      { href: "/analytics", icon: LineChart, label: "Analytics" },
    ],
  },
]

/**
 * Exact-prefix match so `/tests` does not also light up for `/test-specs`,
 * `/test-implementations` or `/test-results`.
 */
function isItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/")
}

export function Sidebar() {
  const pathname = usePathname()
  const { collapsed, toggle } = useSidebar()

  return (
    <div
      className={cn(
        "fixed left-0 top-0 z-40 h-screen transition-all duration-300",
        "border-r bg-card flex flex-col",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Logo Section */}
      <div className="flex h-16 shrink-0 items-center border-b px-4">
        {!collapsed ? (
          <div className="flex items-baseline gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary">
              <span className="text-sm font-bold text-primary-foreground">TM</span>
            </div>
            <span className="text-lg font-semibold">Test Manager</span>
          </div>
        ) : (
          <div className="flex h-8 w-8 mx-auto shrink-0 items-center justify-center rounded bg-primary">
            <span className="text-sm font-bold text-primary-foreground">TM</span>
          </div>
        )}
      </div>

      {/* Navigation - scrollable: 11 entries plus section labels overflow a short viewport */}
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3" aria-label="Main navigation">
        {navSections.map((section, sectionIndex) => (
          <div key={section.label ?? `section-${sectionIndex}`} className="space-y-1">
            {!collapsed && section.label && (
              <p className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {section.label}
              </p>
            )}
            {collapsed && section.label && <div className="my-2 border-t border-border" />}

            {section.items.map((item) => {
              const Icon = item.icon
              const isActive = isItemActive(pathname, item.href)

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors min-h-[40px]",
                    "hover:bg-accent/50",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-accent-foreground",
                    collapsed && "justify-center"
                  )}
                  title={collapsed ? item.label : undefined}
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="ml-3 truncate">{item.label}</span>}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Bottom Section: Settings + Collapse */}
      <div
        className={cn(
          "mt-auto shrink-0 border-t p-3",
          collapsed ? "space-y-2" : "flex items-center gap-2"
        )}
      >
        {/* Settings Link */}
        <Link
          href="/settings"
          className={cn(
            "flex items-center rounded-lg px-3 py-2.5 text-base font-medium transition-colors min-h-[44px]",
            "hover:bg-accent/50",
            pathname === "/settings"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-accent-foreground",
            collapsed ? "justify-center" : "flex-1"
          )}
          title={collapsed ? "Settings" : undefined}
          aria-current={pathname === "/settings" ? "page" : undefined}
        >
          <Settings className="h-6 w-6 shrink-0" aria-hidden="true" />
          {!collapsed && <span className="ml-3">Settings</span>}
        </Link>

        {/* Collapse Button */}
        <button
          onClick={toggle}
          className={cn(
            "rounded-lg p-2.5 hover:bg-accent/50 min-w-[44px] min-h-[44px] flex items-center justify-center",
            "text-muted-foreground hover:text-accent-foreground transition-colors",
            collapsed ? "w-full mx-auto" : "w-auto"
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <ChevronLeft
            className={cn(
              "h-6 w-6 transition-transform",
              collapsed && "rotate-180"
            )}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  )
}
