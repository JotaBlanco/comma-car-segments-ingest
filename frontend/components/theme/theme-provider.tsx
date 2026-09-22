"use client";

/**
 * Theme handling for Test Manager.
 *
 * - The theme is the `dark` class on <html> (Tailwind `@custom-variant dark`
 *   in app/globals.css), persisted under localStorage "tm-theme". Default: light.
 * - No-FOUC: an inline script in app/layout.tsx applies the class during HTML
 *   parsing, before first paint. This provider only re-syncs afterwards.
 *
 * Parent-app alignment hooks (Test Manager is embedded in the Quix portal):
 * 1. `?theme=dark|light` query param on first load overrides the stored value
 *    (handled in the layout inline script, persisted so it sticks).
 * 2. The host can switch the theme at runtime by posting a message to the
 *    iframe: `postMessage({ type: "tm-theme", theme: "dark" | "light" }, "*")`.
 */

import { useEffect, useLayoutEffect, type ReactNode } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "tm-theme";

function storedTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage unavailable — fall through to default
  }
  return "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // best effort — theme still applies for this page view
  }
}

export function toggleTheme(): void {
  applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Re-apply the stored theme before paint. In production this is a no-op
  // (the layout inline script already set the class); in development React
  // Strict Mode remounts reset <html> attributes, which would drop it.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", storedTheme() === "dark");
  }, []);

  // Parent-app hook (2): live theme switching via postMessage.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; theme?: unknown } | null;
      if (
        data !== null &&
        typeof data === "object" &&
        data.type === "tm-theme" &&
        (data.theme === "dark" || data.theme === "light")
      ) {
        applyTheme(data.theme);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return children;
}
