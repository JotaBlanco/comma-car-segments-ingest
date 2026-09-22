import { expect, test } from "@playwright/test";
import { resetDb } from "./support/helpers";

/**
 * Full-flow e2e for the shared table-filters toolbar (spec §6, §2.x).
 *
 * Exercises the wave-1/2 pieces end-to-end on the three full-treatment tables:
 *  - Runs: quick view → popover multi-select → sort toggle → pagination → pill remove
 *          → impossible combo empty state → "Clear everything".
 *  - Files: quick view → popover filter → pill visibility → pager range text.
 *  - Signals: real pager page 2 works (proves the fake "of 6,412" footer is gone).
 *
 * Serial single-worker (playwright.config.ts). `resetDb` before each test.
 */

test.beforeEach(async ({ request }) => {
  await resetDb(request);
});

test("Runs — full toolbar flow: quick view → filter → sort → pager → clear", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: "Test runs" })).toBeVisible();

  /* Step 1: quick view "Invalid" — set-equality preset lights the segment. */
  await page.getByRole("button", { name: /^Invalid$/ }).click();
  await page.waitForURL("/runs?status=invalid");
  await expect(page.getByRole("button", { name: /^Invalid$/, pressed: true })).toBeVisible();
  /* Exactly one seeded invalid run (TAS-88209). Data rows are plain <tr>
     carrying the first-cell id anchor — `:has(a)` counts them and skips the
     empty-state and skeleton rows, which hold no link. */
  await expect(page.locator("tbody tr:has(a)")).toHaveCount(1);

  /* Step 2: swap to "All" then add a structured filter via the popover.
     The count is part of the accessible name now (it stopped being
     aria-hidden — a screen reader should hear it), so the name is
     "All <n>", not the bare label. */
  await page.getByRole("button", { name: /^All/ }).click();
  await page.waitForURL("/runs");

  await page.getByRole("button", { name: /^Rig/ }).click();
  const rigPopover = page.getByRole("dialog", { name: "Rig filter" });
  await expect(rigPopover).toBeVisible();
  await rigPopover.getByRole("checkbox", { name: "RIG-04" }).click();
  /* Applied count badge on the trigger. */
  await expect(page.getByRole("button", { name: /^Rig/ })).toContainText("1");
  /* Close popover. */
  await rigPopover.getByRole("button", { name: "Done" }).click();

  await page.waitForURL("/runs?rig=RIG-04");
  /* Pill visible with group + label. */
  const pillsRow = page.getByRole("list", { name: "Applied filters" });
  await expect(pillsRow.getByRole("listitem").filter({ hasText: "RIG-04" })).toBeVisible();
  /* 12 RIG-04 runs seeded — page size 20 fits them all, no pagination yet. */
  await expect(page.locator("tbody tr:has(a)")).toHaveCount(12);

  /* Step 3: sort toggle on Arrived (first_data_at). Default sort is desc and stripped
     from the URL. `setSort` recognizes the "effective default" and toggles from desc→asc
     on the first click. */
  const arrivedHeader = page.getByRole("columnheader", { name: /Arrived/ });
  await arrivedHeader.getByRole("button").click();
  await page.waitForURL(/order=asc/);
  await expect(arrivedHeader).toHaveAttribute("aria-sort", "ascending");

  /* Step 4: pager — reduce page size to 10 to force two pages. */
  await page.getByLabel("Rows per page").selectOption("10");
  await page.waitForURL(/page_size=10/);
  /* Range text: 1–10 of 12. */
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toContainText("Showing");
  await expect(pager).toContainText("of");
  await expect(pager).toContainText("12");
  await expect(page.locator("tbody tr:has(a)")).toHaveCount(10);

  /* Next page. */
  await pager.getByRole("button", { name: "Next page" }).click();
  await page.waitForURL(/page=2/);
  await expect(page.locator("tbody tr:has(a)")).toHaveCount(2);
  await expect(pager.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");

  /* Step 5: remove the RIG pill — should reset page (setter clears page). */
  await pillsRow.getByRole("button", { name: "Remove filter: Rig RIG-04" }).click();
  /* rig removed; also page reset. Sort + page_size stay in URL. */
  await expect(page).toHaveURL(/^[^?]+\?(?!.*rig=).*$/);
  await expect(pillsRow.getByRole("listitem").filter({ hasText: "RIG-04" })).toHaveCount(0);

  /* Step 6: apply an impossible combo (Rig RIG-02 AND status Invalid — no such run). */
  await page.getByRole("button", { name: /^Rig/ }).click();
  const rigPopover2 = page.getByRole("dialog", { name: "Rig filter" });
  await rigPopover2.getByRole("checkbox", { name: "RIG-02" }).click();
  await rigPopover2.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: /^Status/ }).click();
  const statusPopover = page.getByRole("dialog", { name: "Status filter" });
  /* Checkbox aria-labels come from FilterOption.value when label is JSX (a StatusBadge). */
  await statusPopover.getByRole("checkbox", { name: "invalid" }).click();
  await statusPopover.getByRole("button", { name: "Done" }).click();

  await expect(page.locator("tbody tr:has(a)")).toHaveCount(0);
  /* Empty state row with the recovery action. */
  const clearEverything = page.getByRole("button", { name: "Clear everything" });
  await expect(clearEverything).toBeVisible();

  /* Step 7: Clear everything — URL back to /runs, all rows return. */
  await clearEverything.click();
  await page.waitForURL("/runs");
  await expect(pillsRow).toHaveCount(0);
  /* Seed total = 15 runs; default page_size 20 shows them all. */
  await expect(page.locator("tbody tr:has(a)")).toHaveCount(15);
});

test("Files — quick view + source popover + pager range text", async ({ page }) => {
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();

  /* Quick view "Quarantined" → 2 rows. */
  await page.getByRole("button", { name: "Quarantined" }).click();
  await page.waitForURL("/files?status=quarantined");
  await expect(page.getByRole("button", { name: "Quarantined", pressed: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(2);

  /* Add Source=INCA filter via popover — 1 quarantined INCA file (inv_derate). */
  await page.getByRole("button", { name: /^Source/ }).click();
  const popover = page.getByRole("dialog", { name: "Source filter" });
  await expect(popover).toBeVisible();
  await popover.getByRole("checkbox", { name: "INCA" }).click();
  await popover.getByRole("button", { name: "Done" }).click();

  await page.waitForURL(/source=INCA/);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByText("inv_derate_20260812_1518.mf4")).toBeVisible();

  /* Pills row shows both filters. */
  const pillsRow = page.getByRole("list", { name: "Applied filters" });
  await expect(pillsRow.getByRole("listitem").filter({ hasText: "Quarantined" })).toBeVisible();
  await expect(pillsRow.getByRole("listitem").filter({ hasText: "INCA" })).toBeVisible();

  /* Pager range text: "Showing 1–1 of 1". */
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toContainText("of");
  await expect(pager).toContainText("1");

  /* Clear all — back to all 6 files. */
  await page.getByRole("button", { name: "Clear all" }).click();
  await page.waitForURL("/files");
  await expect(page.locator("tbody tr")).toHaveCount(6);
});

test("Signals — real pager reaches page 2 and the fake '6,412' footer is gone", async ({ page }) => {
  await page.goto("/signals");
  await expect(page.getByRole("heading", { name: "Signals" })).toBeVisible();

  /* Reduce page size so a small seed (14 signals) paginates. */
  await page.getByLabel("Rows per page").selectOption("10");
  await page.waitForURL(/page_size=10/);
  await expect(page.locator("tbody tr")).toHaveCount(10);

  /* The old fake footer said "of 6,412" — assert nowhere on the page. */
  await expect(page.getByText(/of 6[,\s]?412/)).toHaveCount(0);

  /* Real pager shows the actual count. */
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toContainText("of");
  await expect(pager).not.toContainText("6,412");

  /* Next page works. */
  await pager.getByRole("button", { name: "Next page" }).click();
  await page.waitForURL(/page=2/);
  await expect(pager.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
  /* Second page has the remaining signals (14 - 10 = 4). */
  await expect(page.locator("tbody tr")).toHaveCount(4);
});
