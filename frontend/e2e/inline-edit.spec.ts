import { expect, test } from "@playwright/test";
import { HERO_RUN_ID, resetDb, signInPortal } from "./support/helpers";

/**
 * Inline unit edit on the hero run's signals tab.
 * Chamber_Humidity is seeded without a unit (amber "missing" badge + pencil).
 */

const SIGNAL = "Chamber_Humidity";

test.beforeEach(async ({ page, request }) => {
  await resetDb(request);
  // The unit edit names the person who made it, so the pencil needs an identity.
  await signInPortal(page);
});

test("saving a missing unit journals it as manual", async ({ page }) => {
  await page.goto(`/runs/${HERO_RUN_ID}`);

  const row = page.getByRole("row").filter({ hasText: SIGNAL });
  await expect(row.getByText("missing", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: `Edit unit for ${SIGNAL}` }).click();
  /* exact — the pencil button's "Edit unit for …" label contains this string. */
  const input = row.getByLabel(`Unit for ${SIGNAL}`, { exact: true });
  await input.fill("%RH");
  await input.press("Enter");

  await expect(
    page.getByText(`Unit for ${SIGNAL} set to %RH — journalled as manual`),
  ).toBeVisible();

  /* The cell now shows the unit with a manual source badge (via catalog refetch). */
  await expect(row.getByText("%RH", { exact: true })).toBeVisible();
  await expect(row.getByText("manual", { exact: true })).toBeVisible();
  await expect(row.getByText("missing", { exact: true })).toHaveCount(0);

  /* Journalled in run context: hero journal bumps 3 → 4 with the unit entry on top. */
  const journalTab = page.getByRole("tab", { name: /Journal/ });
  await expect(journalTab).toContainText("4");
  await journalTab.click();
  const topEntry = page.getByRole("tabpanel").locator("div.relative").first();
  await expect(topEntry).toContainText(`signal.${SIGNAL}.unit`);
  await expect(topEntry).toContainText("(missing)");
  await expect(topEntry).toContainText("%RH");
  await expect(topEntry).toContainText("manual");
});

test("escape cancels the edit without saving", async ({ page }) => {
  await page.goto(`/runs/${HERO_RUN_ID}`);

  const row = page.getByRole("row").filter({ hasText: SIGNAL });
  await row.getByRole("button", { name: `Edit unit for ${SIGNAL}` }).click();

  const input = row.getByLabel(`Unit for ${SIGNAL}`, { exact: true });
  await input.fill("kPa");
  await input.press("Escape");

  /* Back to the missing badge — no save, no toast, no journal bump. */
  await expect(input).toHaveCount(0);
  await expect(row.getByText("missing", { exact: true })).toBeVisible();
  await expect(page.getByText(`Unit for ${SIGNAL} set to`)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Journal/ })).toContainText("3");
});
