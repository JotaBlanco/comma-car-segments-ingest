/**
 * Explore tab e2e (mock mode, TM_EXPLORE=1 via playwright.config.ts).
 *
 * Run query posts to the FE's own /api/lake/query route — in this rig
 * (TM_TEST_HOOKS=1) that route answers from the in-memory mock db
 * (lib/mock/db.ts runLakeQuery) instead of a real lake.
 *
 *  - Run the seeded query → rows appear in the results panel.
 *  - A write statement (DROP …) → the lake's read-only refusal in the
 *    results panel (the SQL travels verbatim; no guard rejects it inline).
 *  - Switch to Visualise → the Chart.js canvas renders.
 *
 * Per-test db reset follows the deep-links.spec.ts pattern.
 */

import { expect, test } from "@playwright/test";
import { HERO_RUN_ID, resetDb } from "./support/helpers";

test.beforeEach(async ({ request }) => {
  await resetDb(request);
});

async function openExplore(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`/runs/${HERO_RUN_ID}`);
  const tab = page.getByRole("tab", { name: /Explore/ });
  await expect(tab).toBeVisible();
  await tab.click();
  // Scope strip confirms the run-locked context has loaded. exact: true keeps
  // the locator off the editor placeholder comment, which repeats the clause.
  await expect(page.getByText(`run_id = '${HERO_RUN_ID}'`, { exact: true })).toBeVisible();
  // The active tab lives in the URL so a refresh keeps Explore open.
  await expect(page).toHaveURL(/[?&]tab=explore/);
}

test("deep link ?tab=explore renders the Explore tab directly", async ({ page }) => {
  await page.goto(`/runs/${HERO_RUN_ID}?tab=explore`);
  await expect(page.getByRole("tab", { name: /Explore/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText(`run_id = '${HERO_RUN_ID}'`, { exact: true })).toBeVisible();
});

test("running the seeded query returns rows from the mock lake", async ({ page }) => {
  await openExplore(page);

  await page.getByRole("button", { name: /Run query/ }).click();

  // Head readout: row count + lakeside timing (en-GB).
  await expect(page.getByText(/rows · \d+\.\d{2} s lakeside/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible();

  // Data rows carry the run's real signal names in the first column.
  const firstCell = page.locator("tbody tr td").first();
  await expect(firstCell).toContainText(/[A-Za-z]/);
});

test("a DROP statement fails with the lake's read-only refusal in the results panel", async ({
  page,
}) => {
  await openExplore(page);

  const editor = page.getByLabel("SQL editor");
  await editor.fill("DROP TABLE test_signal_samples");
  await editor.press("ControlOrMeta+Enter");

  // The SQL goes to the lake verbatim — no guard rejects it inline any more.
  // The lake refuses the write and the ErrorState (role=alert) shows its
  // detail. Filter past Next's empty route-announcer, which is also role=alert.
  const alert = page.getByRole("alert").filter({ hasText: "read-only" });
  await expect(alert).toContainText("DROP");
  await expect(alert).toContainText("read-only");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a Visualisation tab renders the Chart.js canvas", async ({ page }) => {
  await openExplore(page);

  // The mode segment became a workbench tab strip — viz opens via the + menu.
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: "Visualisation" }).click();
  await expect(page.getByRole("tab", { name: /Visualisation 1/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // The chart canvas appears once the auto-built time_bucket query returns.
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByText(/buckets — ~1 point per pixel/)).toBeVisible();
});
