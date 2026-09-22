import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { MemoryStorage } from "../support/memory-storage";

// Vitest globals are not enabled, so RTL's automatic cleanup does not register.
afterEach(cleanup);

// Node 26 exposes an experimental global `localStorage` that is undefined
// unless the process runs with --localstorage-file, and it shadows jsdom's
// own implementation inside the vitest environment. Every storage-touching
// suite (token store, theme, explore tabs/history) broke on it. A Map-backed
// Storage restores the contract; tests still clear it per-case themselves.
for (const name of ["localStorage", "sessionStorage"] as const) {
  if (typeof window !== "undefined" && window[name] === undefined) {
    const storage = new MemoryStorage();
    Object.defineProperty(window, name, { value: storage, configurable: true });
    Object.defineProperty(globalThis, name, { value: storage, configurable: true });
  }
}
