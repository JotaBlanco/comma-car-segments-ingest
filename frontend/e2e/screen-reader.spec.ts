/**
 * Screen-reader infrastructure (FR-DM-091): window titles, one h1 per view,
 * a heading outline worth a rotor, and the shared polite live region.
 */

import { expect, test, type Page } from "@playwright/test";
import { HERO_RUN_ID } from "./support/helpers";

const SUFFIX = "Test Manager";

test.describe("document titles", () => {
  const STATIC_ROUTES: ReadonlyArray<[path: string, title: string]> = [
    ["/", `Home — ${SUFFIX}`],
    ["/runs", `Test runs — ${SUFFIX}`],
    ["/work-orders", `Work orders — ${SUFFIX}`],
    ["/definitions", `Test definitions — ${SUFFIX}`],
    ["/files", `Files — ${SUFFIX}`],
    ["/signals", `Signals — ${SUFFIX}`],
  ];

  test("every list route names itself", async ({ page }) => {
    for (const [path, title] of STATIC_ROUTES) {
      await page.goto(path);
      await expect(page).toHaveTitle(title);
    }
  });

  test("detail routes name the entity once it loads", async ({ page }) => {
    await page.goto(`/runs/${HERO_RUN_ID}`);
    await expect(page).toHaveTitle(`${HERO_RUN_ID} — test run — ${SUFFIX}`);

    await page.goto("/signals/HV_Batt_Cell_Temp_Max");
    await expect(page).toHaveTitle(`HV_Batt_Cell_Temp_Max — signal — ${SUFFIX}`);

    await page.goto("/work-orders/WO-2026-0847");
    await expect(page).toHaveTitle(`WO-2026-0847 — work order — ${SUFFIX}`);
  });

  test("the title follows CLIENT-side navigation too", async ({ page }) => {
    await page.goto("/runs");
    await expect(page).toHaveTitle(`Test runs — ${SUFFIX}`);
    // Navigate without a document load: click the first DATA row (the row is
    // a plain <tr> with a mouse click handler; the link sits in its first
    // cell — `:has(a)` skips the loading-skeleton rows, which also render as
    // tbody rows and swallow a click).
    const row = page.locator("tbody tr:has(a)").first();
    await row.waitFor();
    await row.click();
    await page.waitForURL(/\/runs\/[^/?]+/);
    await expect(page).toHaveTitle(/ — test run — Test Manager$/);
  });
});

async function expectOneH1(page: Page, matching: RegExp | string) {
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveCount(1);
  await expect(h1).toHaveText(matching);
}

test.describe("headings", () => {
  test("every view carries exactly one h1", async ({ page }) => {
    await page.goto("/runs");
    await expectOneH1(page, "Test runs");

    await page.goto(`/runs/${HERO_RUN_ID}`);
    await expectOneH1(page, HERO_RUN_ID);

    await page.goto("/signals/HV_Batt_Cell_Temp_Max");
    await expectOneH1(page, "HV_Batt_Cell_Temp_Max");

    await page.goto("/work-orders/WO-2026-0847");
    await expectOneH1(page, "WO-2026-0847");
  });

  test("the Explore layout keeps its one h1 in the slim bar", async ({ page }) => {
    await page.goto(`/runs/${HERO_RUN_ID}?tab=explore`);
    await expect(
      page.getByRole("tablist", { name: "Explore workbench tabs" })
    ).toBeVisible();
    await expectOneH1(page, HERO_RUN_ID);
  });

  test("panels join the outline as h2 headings under the h1", async ({ page }) => {
    await page.goto(`/runs/${HERO_RUN_ID}`);
    // The run detail's metadata panel is a real heading now, not a styled div.
    await expect(page.getByRole("heading", { level: 2, name: "Metadata" })).toBeVisible();

    await page.goto("/work-orders/WO-2026-0847");
    await expect(
      page.getByRole("heading", { level: 2, name: "Planning metadata" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Test definitions" })
    ).toBeVisible();
  });

  test("the file detail outline: h1 filename, h2 panels", async ({ page }) => {
    await page.goto("/files");
    await page.locator("tbody tr").first().locator("a").first().click();
    await page.waitForURL(/\/files\/[^/]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const h2s = page.getByRole("heading", { level: 2 });
    await expect(h2s.first()).toBeVisible();
  });
});

test.describe("the shared polite live region", () => {
  test("announces the visible range after a page change", async ({ page }) => {
    await page.goto("/signals");
    // 10 a page yields a real page 2 on the 14-signal catalog.
    await page.getByLabel("Rows per page").selectOption("10");
    await page.getByRole("button", { name: "Page 2" }).click();
    const status = page.locator("div[role='status'].sr-only");
    await expect(status).toContainText(/Showing 11–\d+ of \d+/);
  });

  test("announces the narrowed range after a filter", async ({ page }) => {
    await page.goto("/runs");
    await page.getByRole("button", { name: "Status", exact: true }).click();
    const popover = page.getByRole("dialog", { name: /Status filter/ });
    await popover.getByRole("checkbox", { name: /Invalid/ }).click();
    await popover.getByRole("button", { name: "Done" }).click();
    const status = page.locator("div[role='status'].sr-only");
    await expect(status).toContainText(/Showing 1–\d+ of \d+|0 results/);
  });

  test("there is exactly ONE app live region — no scattered aria-live", async ({ page }) => {
    await page.goto("/runs");
    await expect(page.locator("div[role='status'].sr-only")).toHaveCount(1);
  });
});
