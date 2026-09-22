"use client";

import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { toggleTheme } from "./theme-provider";

/**
 * Sun/moon theme switch. Icon visibility is driven purely by the `dark`
 * variant so the markup is identical on server and client — no hydration
 * mismatch, no flash.
 */
export function ThemeToggle({ className }: { className?: string }) {
  return (
    <button
      type="button"
      aria-label="Toggle dark theme"
      title="Toggle dark theme"
      onClick={toggleTheme}
      className={cn(
        "grid size-7 place-items-center rounded-md border border-line bg-surface text-ink-2 transition-colors hover:border-line-strong hover:text-ink",
        className
      )}
    >
      <Sun size={14} strokeWidth={2} aria-hidden className="dark:hidden" />
      <Moon size={14} strokeWidth={2} aria-hidden className="hidden dark:block" />
    </button>
  );
}
