"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ClipboardList,
  Compass,
  Database,
  FileText,
  FlaskConical,
  Home,
  LayoutDashboard,
  ListChecks,
  NotebookText,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { NewTabMark } from "@/components/shared/new-tab-mark";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompact, formatInt } from "@/lib/format";
import { useHomeSummary, usePlanningSyncStatus } from "@/lib/hooks";
import { getLakehouseUrl, listQuixLabs } from "@/lib/api/integrations";
import { ftsConfigured } from "@/lib/fts";
import { KIND_DEPLOYMENT, quixLabConfigured, setQuixLabPortalUrl } from "@/lib/quixlab";
import { cn } from "@/lib/utils";

export interface SidebarCounts {
  runs?: string | number;
  workOrders?: string | number;
  definitions?: string | number;
  requirements?: string | number;
  files?: string | number;
  signals?: string | number;
}

interface SidebarProps {
  counts?: SidebarCounts;
}

interface NavEntry {
  label: string;
  href: string;
  icon: LucideIcon;
  count?: string | number;
  /** Nesting level under the entry above it. Absent is a top-level entry. */
  depth?: 1 | 2;
}

/** Left padding per nesting level. The rail has no room for one, so it indents
    nothing and keeps the same order. */
const INDENT: Record<number, string> = { 1: "pl-7", 2: "pl-11" };

/* Proportions come from the Portal sidenav: a 232px panel collapses to a 56px
   icon rail, over 300ms on the Material standard easing curve. */
export const SIDEBAR_STORAGE_KEY = "tm-sidebar-collapsed";
const RAIL_WIDTH = "56px";
const PANEL_WIDTH = "232px";

const navItemClass =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink";

function NavLabel({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "px-2.5 pt-2.5 pb-1.5 text-[0.65rem] font-semibold tracking-[0.09em] text-ink-3 uppercase",
        className
      )}
    >
      {children}
    </div>
  );
}

/* The collapsed flag lives in localStorage, and React reads it through
   `useSyncExternalStore`. The server and the hydration pass both take
   `serverSnapshot`, so the markup matches and the page needs no post-mount
   `setState`. The client snapshot then applies the stored state. Same pattern
   as components/shared/kbd.tsx. */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // A second tab writes the key too.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Holds the state when localStorage is blocked, so the toggle still works. */
let inMemoryCollapsed = false;

/** Reads the stored state. Never throws — a blocked localStorage keeps the default. */
function clientSnapshot(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return inMemoryCollapsed;
  }
}

/** The server has no localStorage, so it renders the expanded panel. */
const serverSnapshot = (): boolean => false;

function storeCollapsed(next: boolean): void {
  inMemoryCollapsed = next;
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
  } catch {
    // best effort — the sidebar still collapses for this page view
  }
  for (const onChange of listeners) onChange();
}

export function Sidebar({ counts }: SidebarProps) {
  const pathname = usePathname();
  /* Contract §1: /home/summary also serves the sidebar counts.
     §20: the sync status feeds the sidebar footer. */
  const { data: summary } = useHomeSummary();
  const { data: sync } = usePlanningSyncStatus();
  const summaryCounts = summary?.counts;
  const resolved: SidebarCounts = counts ?? {
    runs: summaryCounts !== undefined ? formatInt(summaryCounts.test_runs) : undefined,
    workOrders: summaryCounts !== undefined ? formatInt(summaryCounts.work_orders) : undefined,
    // An API built before this count sends no field. Read it as zero, or the
    // sidebar prints NaN.
    definitions:
      summaryCounts !== undefined ? formatInt(summaryCounts.test_definitions ?? 0) : undefined,
    // An API built before the requirement catalog lands sends no field —
    // same fallback-to-zero rule as `definitions` above.
    requirements:
      summaryCounts !== undefined ? formatInt(summaryCounts.requirements ?? 0) : undefined,
    files: summaryCounts !== undefined ? formatInt(summaryCounts.files) : undefined,
    signals: summaryCounts !== undefined ? formatCompact(summaryCounts.signals) : undefined,
  };

  const collapsed = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);

  /* The Explore and the QuixLab overlays are `fixed` and they start at the
     sidebar edge, so they read the width from this variable. */
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--sidebar-w",
      collapsed ? RAIL_WIDTH : PANEL_WIDTH
    );
  }, [collapsed]);

  /* The Portal's Lakehouse page for this workspace. Empty means "no row".

     `getLakehouseUrl` waits for the viewer's Portal token itself, the way
     `listQuixLabs` does, so this effect may fire on the mount. The route asks
     the Portal nothing, but it still sits behind the bearer guard, and the
     proxy lends no shared token on a deployed front end. See the comment on
     `getLakehouseUrl` in `lib/api/integrations.ts`.

     The row's VISIBILITY depends on this async value, so it lives in React
     state and not in a module variable: the sidebar must render again when it
     lands. The effect runs once, and the answer arrives in the `then`, so a
     token that lands late still shows the row. `/lakehouse` asks for the URL
     again, because a page that is opened directly has no sidebar answer to
     read. */
  const [lakehouseUrl, setLakehouseUrl] = useState("");

  /* Resolve the Portal's embedded view of the workspace QuixLab, once.

     It is the module value the controls that open a TAB read (`openQuixLab`
     and `openQuixLabNode` in `lib/quixlab.ts`), and a tab must land inside the
     Portal rather than on the raw deployment host. The Portal route names a
     DEPLOYMENT id and `TM_QUIXLAB_URL` carries none — the demo value is
     `quixlab-cb331d0-...`, where `cb331d0` is the git commit the deployment is
     pinned to — so `GET /integrations/quixlabs` is the one call that resolves
     it.

     The sidebar mounts once for the whole app, above the router, so the call
     happens once per session and never on a click. `listQuixLabs` waits for
     the viewer's Portal token itself, so this effect may fire on the mount.
     Every failure is silent: an empty list, a refusal and an outage all leave
     the direct QuixLab URL in place. */
  useEffect(() => {
    if (!quixLabConfigured()) return undefined;
    let live = true;
    getLakehouseUrl().then(
      (url) => {
        if (live) setLakehouseUrl(url);
      },
      () => {
        // No URL, so the row stays hidden.
      },
    );
    listQuixLabs().then(
      (found) => {
        if (!live) return;
        const shared = found.find(
          (item) =>
            item.kind === KIND_DEPLOYMENT && (item.portal_embedded_url ?? "").length > 0,
        );
        setQuixLabPortalUrl(shared?.portal_embedded_url ?? null);
      },
      () => {
        // No Portal URL, so the direct link stands.
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const toggle = useCallback(() => storeCollapsed(!clientSnapshot()), []);

  /* The three planning entries nest the domain chain: a work order is a
     campaign holding test runs, and a run covers test definitions. The indent
     carries the chain, so the list teaches the model. Each entry still names
     its own whole-registry list — the indent states what contains what, never
     that a list is filtered by the entry above it. */
  const registry: NavEntry[] = [
    { label: "Home", href: "/", icon: Home },
    { label: "Work orders", href: "/work-orders", icon: ClipboardList, count: resolved.workOrders },
    { label: "Test runs", href: "/runs", icon: Timer, count: resolved.runs, depth: 1 },
    /* Sits directly above Test definitions, same depth: a requirement is
       covered BY a definition, so a reader meets the thing being verified
       just before the thing that verifies it (requirement-status-from-runs
       spec §7.3). */
    {
      label: "Requirements",
      href: "/requirements",
      icon: ListChecks,
      count: resolved.requirements,
      depth: 2,
    },
    /* The definitions list and the definition detail both ship. Without this
       entry the only way in is the Home "orphaned definitions" line. */
    {
      label: "Test definitions",
      href: "/definitions",
      icon: FlaskConical,
      count: resolved.definitions,
      depth: 2,
    },
    { label: "Files", href: "/files", icon: FileText, count: resolved.files },
    { label: "Signals", href: "/signals", icon: Activity, count: resolved.signals },
    /* The lake's findings across every run. No count: the home summary reads the
       registry, and the issues live in the lake. */
    { label: "Issues", href: "/issues", icon: AlertTriangle },
    /* Saved station dashboards. Kept in this browser, so no count from the API.

       Gated on the Flight Test Station being configured, because a workbook IS
       the station: the pages frame it and read their data through /api/fts,
       which answers 503 with no TM_FTS_URL. An estate that deploys no station
       would otherwise show a nav entry whose every page is empty. Set
       TM_FTS_URL and the entry comes back — the screens are untouched. */
    ...(ftsConfigured()
      ? [{ label: "Workbooks", href: "/workbooks", icon: LayoutDashboard }]
      : []),
    /* QuixLab's Explorer over the lake, as a page here. No count: it is a view, not a list. */
    { label: "Explore", href: "/explore", icon: Compass },
    /* The journal of every entity, with its own filters (FR-DM-055). The six
       entity screens each show one history, and no screen showed the whole
       journal. It carries no count, because the home summary counts no
       journal entries. */
    { label: "Audit", href: "/audit", icon: ScrollText },
  ];

  /* Both frame their target in the content area, so they are ordinary nav
     rows: same active state, same tooltip on the rail. The Lakehouse row waits
     for its URL — an empty answer means this workspace has no Lakehouse page,
     and the row then never appears. */
  const analysis: NavEntry[] = !quixLabConfigured()
    ? []
    : [
        { label: "QuixLab", href: "/quixlab", icon: NotebookText },
        ...(lakehouseUrl.length > 0
          ? [{ label: "Lakehouse", href: "/lakehouse", icon: Database }]
          : []),
      ];

  const isActive = (href: string): boolean =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  /* The rail hides the label and the count from the eye only. Both stay in the
     accessible name, so a screen reader loses nothing, and the tooltip gives
     the same two facts back to a mouse or to a keyboard. */
  const hideText = collapsed ? "sr-only" : undefined;
  const rowClass = collapsed ? "justify-center px-0" : undefined;

  const row = (entry: NavEntry) => {
    const active = isActive(entry.href);
    const Icon = entry.icon;
    const link = (
      <Link
        key={entry.href}
        href={entry.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          navItemClass,
          rowClass,
          collapsed ? undefined : INDENT[entry.depth ?? 0],
          active && "bg-accent-soft font-semibold text-primary hover:bg-accent-soft hover:text-primary"
        )}
      >
        <Icon size={15} strokeWidth={2} className={cn("flex-none", active ? "opacity-100" : "opacity-65")} />
        <span className={hideText}>{entry.label}</span>
        {entry.count !== undefined && (
          /* The space keeps the count off the label in the accessible
             name ("Test runs 12", not "Test runs12"). Flexbox drops a
             whitespace-only item, so it changes no pixel.
             a11y: on the active row's accent-soft tint, ink-3 falls below
             4.5:1 in the dark theme — step up to ink-2 there. */
          <>
          {" "}
          <span
            className={cn(
              "ml-auto font-mono text-[0.7rem]",
              hideText,
              active ? "text-ink-2" : "text-ink-3"
            )}
          >
            {entry.count}
          </span>
          </>
        )}
      </Link>
    );
    if (!collapsed) return link;
    return (
      <Tooltip key={entry.href}>
        <TooltipTrigger render={link} />
        <TooltipContent side="right">
          {entry.count === undefined ? entry.label : `${entry.label} (${entry.count})`}
        </TooltipContent>
      </Tooltip>
    );
  };

  // aria-label: the page holds several navs (pagination, crumbs), and an
  // unnamed landmark reads as bare "navigation" in the rotor (FR-DM-091).
  return (
    <TooltipProvider delay={200}>
      <nav
        data-shell-chrome
        data-collapsed={collapsed ? "true" : "false"}
        aria-label="Primary"
        style={{ width: collapsed ? RAIL_WIDTH : PANEL_WIDTH }}
        className="flex flex-col gap-0.5 overflow-x-hidden overflow-y-auto border-r border-line bg-surface px-2.5 py-3.5 transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none"
      >
        {!collapsed && <NavLabel>Registry</NavLabel>}
        {registry.map(row)}
        {analysis.length > 0 && (
          <>
            {collapsed ? (
              <div aria-hidden className="mx-1.5 mt-3 mb-1 h-px bg-line-2" />
            ) : (
              <NavLabel className="mt-3">Analysis</NavLabel>
            )}
            {analysis.map(row)}
          </>
        )}
        <div className="mt-auto border-t border-line-2 pt-2">
          {/* The toggle sits at the foot of the rail, as it does in the Portal. */}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            className={cn(navItemClass, rowClass)}
          >
            {collapsed ? (
              <PanelLeftOpen size={15} strokeWidth={2} className="flex-none opacity-65" />
            ) : (
              <PanelLeftClose size={15} strokeWidth={2} className="flex-none opacity-65" />
            )}
            <span className={hideText}>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
          </button>
          {/* The rail is too narrow for the version and the sync state, and a
              cut string reads wrong, so the footer hides. */}
          {!collapsed && (
            <div className="p-2.5 text-[0.68rem] text-ink-3">
              {/* The Swagger page opens in a tab. The app runs in the Portal
                  frame, and a document that replaces the frame loses the
                  screen a person was reading.
                  The words name the page, the icon says the link leaves the
                  app, and the underline marks it as a link. `text-ink-2` lifts
                  the link off the ink-3 footer: 8.21:1 on the light surface and
                  8.42:1 on the dark one. The hover accent holds 9.55:1 light
                  and 6.34:1 dark. */}
              <a
                href="/docs"
                target="_blank"
                rel="noreferrer"
                title="Open the Swagger API reference in a new tab"
                className="inline-flex items-center gap-1.5 rounded-sm text-ink-2 transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {/* The underline sits on the text only. On the anchor it would
                    also draw a rule under the icon. */}
                <span className="underline decoration-1 underline-offset-[3px]">
                  Swagger API reference <span className="font-mono text-[0.65rem]">v1</span>
                </span>
                {/* The mark trails the label here too. The icon states what
                    the activation does, so it reads after the name — the same
                    grammar as the nav rows, and a leading icon would take the
                    slot a nav row keeps for its identity icon. A screen
                    reader hears the fact in the mark's words; the title
                    attribute only serves the mouse. */}
                <NewTabMark />
              </a>
              {sync !== undefined && (
                <div className="mt-1">
                  Planning sync:{" "}
                  <b className={sync.online ? "text-green" : "text-amber"}>
                    {sync.online ? "online" : "offline"}
                  </b>
                </div>
              )}
            </div>
          )}
        </div>
      </nav>
    </TooltipProvider>
  );
}
