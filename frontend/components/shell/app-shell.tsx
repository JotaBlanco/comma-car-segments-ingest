import type { ReactNode } from "react";
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { AssistantProvider } from "@/components/assistant/assistant-provider";
import { SignedOutScreen } from "@/components/account/signed-out-screen";
import { AnnouncerProvider } from "@/lib/hooks/use-announce";
import { FocusOnRouteChange } from "./focus-on-route-change";
import { Sidebar, type SidebarCounts } from "./sidebar";
import { Topbar } from "./topbar";

interface AppShellProps {
  children: ReactNode;
  counts?: SidebarCounts;
}

export function AppShell({ children, counts }: AppShellProps) {
  return (
    /* AppShell stays a server component: the client AssistantProvider renders
       these server children untouched, so only the topbar trigger and the
       panel column hydrate. The third grid column is `auto` — the panel aside
       animates its own width (384px open, 0 closed) and the grid follows. */
    <AssistantProvider>
      {/* ONE polite live region for the whole app — every loading/filter/
          sort/page announcement funnels through it (FR-DM-091). */}
      <AnnouncerProvider>
      {/* First tabbable on every page: visually hidden until focused, then a
          small pill over the topbar. Targets the landmark main below —
          `tabIndex={0}` there makes the jump take focus, not only scroll. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:border focus:border-line focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink focus:outline-2 focus:outline-ring"
      >
        Skip to main content
      </a>
      {/* After every client-side navigation, focus lands on <main> — see the
          component's doc block. */}
      <FocusOnRouteChange />
      {/* Four columns: nav · left-dock slot · content · right-dock slot. The
          dock slots are `auto`, so whichever one the assistant panel does not
          occupy (or both, when it floats) collapses to zero. Row-2 children
          carry explicit placements — the panel places itself by definite
          row+column, and definite-row items are laid out before auto-flow
          ones, so auto placement here would put main in the wrong column. */}
      <div className="grid h-screen grid-cols-[auto_auto_minmax(0,1fr)_auto] grid-rows-[52px_1fr]">
        <Topbar />
        <Sidebar counts={counts} />
        {/* Main is bounded by the parent grid's `1fr` row (viewport - 52px topbar).
            `overflow-y-auto` preserves normal page scrolling for Home + detail pages.
            The inner `min-h-full flex flex-col` on the max-width column lets opt-in
            list screens wrap content in `h-full flex flex-col` (see FullHeightPage)
            so the Panel can flex-fill and scroll internally without a page scroll. */}
        {/* tabIndex: pages with no interactive content (e.g. file detail) must stay
            keyboard-scrollable (axe scrollable-region-focusable, WCAG 2.1.1). */}
        <main
          id="main-content"
          tabIndex={0}
          className="col-start-3 row-start-2 overflow-y-auto px-8 pt-[26px] pb-16 focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          <div className="mx-auto flex min-h-full w-full max-w-[1280px] flex-col">
            {children}
          </div>
        </main>
        <AssistantPanel />
      </div>
      {/* Covers the app only when no token reached it. The component itself
          returns nothing while the phase is "resolving". */}
      <SignedOutScreen />
      </AnnouncerProvider>
    </AssistantProvider>
  );
}
