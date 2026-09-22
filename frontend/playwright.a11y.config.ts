import { defineConfig, devices } from "@playwright/test";

/**
 * Accessibility (axe-core) scan config.
 *
 * IMPORTANT: unlike playwright.config.ts this config has NO webServer block —
 * it requires the dev server to already be running, on http://localhost:3400
 * by default. `TM_A11Y_URL` points the suite at another server (a second
 * worktree's dev server, a CI port) without touching this file. Run with:
 *
 *   npm run test:a11y
 *   TM_A11Y_URL=http://localhost:3401 npm run test:a11y
 *   npx playwright test --config playwright.a11y.config.ts
 *
 * Scans are serial (single worker) so theme toggling and dialog state never
 * race between tests.
 */
const BASE_URL = process.env.TM_A11Y_URL ?? "http://localhost:3400";

export default defineConfig({
  testDir: "e2e",
  testMatch: "a11y.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  /* First hit on a dev-server route triggers compilation — be generous. */
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    /* Every scan starts signed in, so the signed-out screen never covers the
       screen under test. See the same block in playwright.config.ts. */
    storageState: {
      cookies: [],
      origins: [
        {
          origin: BASE_URL,
          localStorage: [{ name: "tm.portal.token", value: "tm-demo-4711" }],
        },
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
