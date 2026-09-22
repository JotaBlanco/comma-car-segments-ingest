import { expect, test } from "@playwright/test";
import {
  MISSING_UNIT_SIGNALS,
  QUARANTINED_FILE,
  openSearchViaTopbar,
  resetDb,
  searchInput,
} from "./support/helpers";

test.beforeEach(async ({ request }) => {
  await resetDb(request);
});

test("/files?status=quarantined shows only quarantined files", async ({ page }) => {
  await page.goto("/files?status=quarantined");
  await expect(page.getByRole("button", { name: "Quarantined", pressed: true })).toBeVisible();

  await expect(page.getByText(QUARANTINED_FILE)).toBeVisible();
  await expect(page.getByText("inv_derate_20260812_1518.mf4")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  /* Registered files are filtered out. */
  await expect(page.getByText("bat_cyc_20260814_0941.mf4")).toHaveCount(0);
  /* Both rows carry the red Quarantined badge (scoped to the table —
     the filter chip carries the same label). */
  await expect(page.locator("tbody").getByText("Quarantined", { exact: true })).toHaveCount(2);
});

test("/signals?missing_unit=true shows the two unit-less signals", async ({ page }) => {
  await page.goto("/signals?missing_unit=true");
  await expect(page.getByRole("button", { name: "Missing unit", pressed: true })).toBeVisible();

  for (const name of MISSING_UNIT_SIGNALS) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("missing", { exact: true })).toHaveCount(2);
  await expect(page.getByText("HV_Batt_Pack_Voltage")).toHaveCount(0);
});

test("/runs?status=invalid lists only the invalid run", async ({ page }) => {
  await page.goto("/runs?status=invalid");
  await expect(page.getByRole("button", { name: "Invalid", pressed: true })).toBeVisible();

  /* Rows are plain <tr> again — the link role lives on the first-cell id
     anchor, so count data rows by that anchor. */
  await expect(page.locator("tbody tr:has(a)")).toHaveCount(1);
  const row = page.locator("tbody tr").filter({ hasText: "TAS-88209" });
  await expect(row.getByRole("link", { name: "TAS-88209" })).toBeVisible();
  await expect(row.getByText("Invalid", { exact: true })).toBeVisible();
});

test("an unknown run id renders a styled not-found state", async ({ page }) => {
  await page.goto("/runs/NOPE-1");
  await expect(page.getByText("Run not found")).toBeVisible();
  await expect(page.getByText(/No test run/)).toContainText("NOPE-1");
  const backLink = page.getByRole("link", { name: "Back to runs" });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForURL("/runs");
  await expect(page.getByRole("heading", { name: "Test runs" })).toBeVisible();
});

test("browser back after search navigation restores the previous page", async ({ page }) => {
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();

  await openSearchViaTopbar(page);
  await searchInput(page).fill("88213");
  await page.getByRole("option", { name: /TAS-88213/ }).first().click();
  await page.waitForURL("/runs/TAS-88213");

  await page.goBack();
  await page.waitForURL("/files");
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
  await expect(page.getByText(QUARANTINED_FILE)).toBeVisible();
});
