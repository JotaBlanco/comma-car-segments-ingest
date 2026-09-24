"use client";

import { Search } from "lucide-react";
import { Kbd } from "@/components/shared/kbd";
import { AccountMenu } from "@/components/account/account-menu";
import { AskTrigger } from "@/components/assistant/ask-trigger";
import { GlobalSearch } from "@/components/search/global-search";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { FavouritesMenu } from "./favourites-menu";
import { NotificationBell } from "./notification-bell";
import { BrandMark } from "./brand-mark";

export function Topbar() {
  return (
    <header data-shell-chrome className="z-20 col-span-full flex items-center gap-4 border-b border-line bg-surface px-4">
      <div className="flex w-[216px] items-center gap-2.5">
        <BrandMark className="size-[26px] flex-none" />
        <div className="font-bold tracking-[-0.01em]">Test Manager</div>
      </div>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("open-global-search"))}
        className="flex flex-[0_1_460px] items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-left text-ink-3 transition-colors hover:border-line-strong"
      >
        <Search size={14} strokeWidth={2} aria-hidden />
        Search runs, files, signals, work orders…
        <Kbd keyLabel="K" className="ml-auto" />
      </button>
      <div className="ml-auto flex items-center gap-3.5">
        {/* Between search and the right cluster, per the concept mock — hidden
            until /assistant/status confirms the feature. */}
        <AskTrigger />
        <GlobalSearch />
        <FavouritesMenu />
        <NotificationBell />
        <ThemeToggle />
        <AccountMenu />
      </div>
    </header>
  );
}
