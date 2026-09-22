import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  // vitest's bundled vite types omit `jsx`, but esbuild honours it at runtime
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  } as Record<string, unknown> as never,
  test: {
    // Capped at 4: several agents run suites at once in separate worktrees.
    maxWorkers: 4,
    include: ["tests/components/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    // vitest 4 stopped defaulting jsdom to a real origin; on about:blank the
    // origin is opaque and window.localStorage is undefined, which broke every
    // storage-touching suite (token store, theme, explore tabs/history).
    environmentOptions: { jsdom: { url: "http://localhost:3000" } },
    setupFiles: ["tests/components/setup.ts"],
    // The suite gave three different failure sets in three runs on the same
    // tip: 9, then 2, then 1 failure, every one a `waitFor` timeout, and every
    // file passing on its own. The default 5000 ms is what the workers lose
    // under load, not the code. Raised 21 Aug 2026.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
