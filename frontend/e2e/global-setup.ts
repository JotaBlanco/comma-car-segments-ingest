import type { FullConfig } from "@playwright/test";

/**
 * Refuse an e2e run that Playwright resolved to more than one worker.
 *
 * `playwright.config.ts` sets `workers: 1`, but a `--workers=<n>` flag on the
 * command line beats the config file. Somebody passed that flag, read the two
 * random failures as an app regression, and lost an hour on 24 Aug 2026.
 *
 * `config.workers` is the number Playwright really resolved, so this guard
 * catches the flag, the `-j` short form and an edit to the config alike.
 *
 * One limit, and it is a limit of the runner, not of this check: Playwright
 * starts the `webServer` block before it runs a global setup. So the build
 * still runs, and the refusal lands after it. It lands before the first test.
 */
export default function assertSingleWorker(config: Pick<FullConfig, "workers">): void {
  if (config.workers <= 1) return;

  throw new Error(
    [
      `Refusing to run: Playwright resolved ${config.workers} workers, and this suite needs exactly 1.`,
      "",
      "The mock database is ONE process-global object (lib/mock/db.ts:79), and",
      "`resetDb` (lib/mock/db.ts:86) REPLACES that whole object. Ten spec files",
      "call it in `beforeEach`. With a second worker, one spec's reset wipes the",
      "state another spec is reading, so tests fail at random and the failures",
      "read as an app regression.",
      "",
      "Drop the `--workers` flag and run `npx playwright test` again.",
    ].join("\n"),
  );
}
