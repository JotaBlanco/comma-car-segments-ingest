/**
 * Map-backed localStorage for the node-env unit suite (vitest 4 dropped the
 * per-file @vitest-environment pragma). The explore stores reach storage as
 * `window.localStorage` behind a `typeof window` guard, so this installs both
 * a `window` alias and the storage object on globalThis.
 */

import { MemoryStorage } from "../../support/memory-storage";

export function installLocalStorage(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.localStorage = new MemoryStorage();
  if (typeof window === "undefined") globals.window = globalThis;
}
