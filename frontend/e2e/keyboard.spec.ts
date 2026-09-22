/**
 * Keyboard operability per view (FR-DM-090) — the repo's first Tab-order
 * coverage.
 *
 * - Skip link: first Tab stop on every page, jumps focus into <main>.
 * - Row activation: rows are plain `<tr>` (the table keeps its row semantics);
 *   the keyboard path is the real link on the row's id in the first cell.
 * - Details popover (Explore slim bar): Escape closes, focus returns to the
 *   trigger — the hand-rolled overlay it replaced did neither.
 * - Focus mode (⇧F): the hidden app chrome turns `inert`, so tabbing never
 *   lands on invisible controls; leaving focus mode restores it.
 * - Route-change focus: client-side navigation moves focus to <main>, so
 *   keyboard users never keep tabbing from a control that no longer exists.
 */

import { expect, test, type Page } from "@playwright/test";
import { HERO_RUN_ID } from "./support/helpers";

/** The shell <main> — the skip link's target and the route-change focus home. */
function main(page: Page) {
  return page.locator("main#main-content");
}

test.describe("skip link", () => {
  test("is the first Tab stop and moves focus into main", async ({ page }) => {
    await page.goto("/runs");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(main(page)).toBeFocused();
  });
});

test.describe("row activation — the first-cell link", () => {
  /* The row itself takes no tabIndex: the Tab stop is the real `<a>` on the
     row's id in the first cell. Enter is the native anchor gesture — Space
     belongs to buttons, and on a link it scrolls, so it is not asserted. */

  test("the runs table's id link opens the run", async ({ page }) => {
    await page.goto("/runs");
    const firstLink = page.locator("tbody tr a").first();
    await firstLink.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/runs\/[^/?]+/);
  });

  test("the signals table's name link opens the signal", async ({ page }) => {
    await page.goto("/signals");
    await page.locator("tbody tr a").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/signals\/[^/?]+/);
  });

  test("the work-orders table's id link opens the work order", async ({ page }) => {
    await page.goto("/work-orders");
    await page.locator("tbody tr a").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/work-orders\/[^/?]+/);
  });

  test("the signal-detail statistics link opens the run", async ({ page }) => {
    await page.goto("/signals/HV_Batt_Cell_Temp_Max");
    await page.locator("tbody tr a").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/runs\/[^/?]+/);
  });

  test("a click anywhere on the row still opens the run", async ({ page }) => {
    /* The link carries the keyboard; the whole row stays the mouse target.
       Wait for a DATA row (`:has(a)`) — the loading skeleton also renders
       tbody rows, and a click on one goes nowhere. */
    await page.goto("/runs");
    const row = page.locator("tbody tr:has(a)").first();
    await row.waitFor();
    await row.locator("td").last().click();
    await page.waitForURL(/\/runs\/[^/?]+/);
  });
});

test.describe("details popover on the Explore slim bar", () => {
  test("Escape closes it and focus returns to the trigger", async ({ page }) => {
    await page.goto(`/runs/${HERO_RUN_ID}?tab=explore`);
    const trigger = page.getByRole("button", { name: "Details" });
    await trigger.click();
    const popover = page.getByRole("dialog", { name: "Run details" });
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe("Explore focus mode", () => {
  test("hides the app chrome from the tab order via inert, and restores it", async ({
    page,
  }) => {
    await page.goto(`/runs/${HERO_RUN_ID}?tab=explore`);
    await expect(
      page.getByRole("tablist", { name: "Explore workbench tabs" })
    ).toBeVisible();

    const sidebar = page.locator("nav[data-shell-chrome]");
    await expect(sidebar).not.toHaveAttribute("inert", "");

    // The button's name carries the ⇧F kbd hint, so match the prefix.
    await page.getByRole("button", { name: /^Focus/ }).click();
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(page.locator("header[data-shell-chrome]")).toHaveAttribute("inert", "");

    await page.getByRole("button", { name: /Exit focus/ }).click();
    await expect(sidebar).not.toHaveAttribute("inert", "");
  });
});

test.describe("route-change focus", () => {
  test("client-side navigation moves focus to main", async ({ page }) => {
    await page.goto("/runs");
    await page.locator("tbody tr a").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/runs\/[^/?]+/);
    await expect(main(page)).toBeFocused();
  });

  test("sidebar navigation moves focus to main", async ({ page }) => {
    await page.goto("/");
    // exact — the Home screen also shows a "Files registered" card link.
    await page.getByRole("link", { name: "Files", exact: true }).click();
    await page.waitForURL(/\/files/);
    await expect(main(page)).toBeFocused();
  });
});
