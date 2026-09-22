/**
 * Platform detection helpers for rendering keyboard-shortcut hints.
 *
 * Keyboard hints use the ⌘ (Command) symbol on macOS but "Ctrl" elsewhere.
 * Detection is guarded so it is safe to call during server-side rendering,
 * where it deterministically returns the macOS default (⌘) so the server
 * markup matches the first client paint and no hydration mismatch occurs.
 */

/** The modifier glyph shown on macOS. Also the SSR / first-paint default. */
export const MAC_MODIFIER = "⌘";

/** The modifier label shown on Windows / Linux. */
export const CTRL_MODIFIER = "Ctrl";

interface UserAgentDataLike {
  platform?: string;
}

/**
 * True when the current client is running macOS.
 *
 * Returns `false` on the server (no `navigator`) — callers should treat the
 * server render as macOS via {@link MAC_MODIFIER} default and only correct
 * the value after mount to avoid a hydration mismatch.
 */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;

  const uaData = (navigator as Navigator & { userAgentData?: UserAgentDataLike })
    .userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";

  return /mac/i.test(platform);
}

/**
 * The modifier token to display for a keyboard hint on the current platform.
 * On the server this always returns {@link MAC_MODIFIER} for a stable first
 * paint; correct it after mount when `isMac()` becomes reliable.
 */
export function modifierGlyph(): string {
  return isMac() ? MAC_MODIFIER : CTRL_MODIFIER;
}
