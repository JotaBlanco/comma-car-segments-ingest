import { defineConfig, devices } from "@playwright/test";

const PORT = 3499;
const BASE_URL = `http://localhost:${PORT}`;
const isCI = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: "e2e",
  /* Axe scans have their own config (playwright.a11y.config.ts) and run
     against the manually-started dev server on 3400 — not this webServer. */
  testIgnore: "a11y.spec.ts",
  /* The mock db is a single in-memory global on the server — parallel
     tests would collide on shared state. One worker, serial files. */
  fullyParallel: false,
  workers: 1,
  /* A `--workers=<n>` flag on the command line beats the two lines above, and
     the run then fails at random instead of saying why. `e2e/global-setup.ts`
     refuses that run and names the reason. */
  globalSetup: "./e2e/global-setup.ts",
  retries: isCI ? 1 : 0,
  /* Route compilation on first hit can be slow; production build+start is quicker per
     request but the initial build takes longer — expect the webServer boot to dominate. */
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    /* Every spec starts signed in. `components/account/signed-out-screen.tsx`
       covers the app when no token reached it, and these specs test the app
       behind it. The value matches `signInPortal` in e2e/support/helpers.ts:
       the mock backend accepts the shared token. */
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
  webServer: {
    /* Production build + start against an isolated `.next-e2e` dist so we never fight
       the user's live `npm run dev` on :3400 for the shared `.next` lock. Both `build`
       and `start` need `NEXT_DIST_DIR` so start reads what build wrote. */
    command: "npm run build && npm run start",
    url: `${BASE_URL}/ready`,
    /* Never reuse. A stale process left on the port would serve the whole suite
       from an old build, and the suite would pass against dead code. */
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      PORT: String(PORT),
      NEXT_DIST_DIR: ".next-e2e",
      /* Enables POST /api/test/reset for per-test isolation. */
      TM_TEST_HOOKS: "1",
      /* Force built-in mock mode: explicit process-env vars beat .env.local,
         and next.config treats empty string as "not configured".
         Do NOT set API_URL (even empty) — the proxy route uses `??`, so an
         empty string would be taken literally and break the target URL. */
      TM_BE_URL: "",
      TM_API_TOKEN: "tm-demo-4711",
      NEXT_PUBLIC_TM_API_TOKEN: "tm-demo-4711",
      /* Explore tab feature flag (plan §4) — server-side only. */
      TM_EXPLORE: "1",
      /* The platform injects this name, and `lib/portal/client.ts` refuses to
         call a Portal without it. No value means no profile call, so a write
         control never finds an actor and stays disabled for ever. The host is
         never reached: `signInPortal` answers both Portal calls in the page. */
      Quix__Portal__Api: "http://portal-api.e2e.invalid",
      TZ: "UTC",
    },
  },
});
