/**
 * WCAG 2.1 AA automated accessibility scans (axe-core) — every screen in both
 * themes, plus the two key interactive states (⌘K search overlay, the
 * Mark-invalid dialog).
 *
 * Runs against an ALREADY-RUNNING dev server — http://localhost:3400 by
 * default, or the `TM_A11Y_URL` override — see playwright.a11y.config.ts (no
 * webServer block on purpose). Start `npm run dev` first, then
 * `npm run test:a11y`.
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openSearchViaTopbar } from "./support/helpers";

/** WCAG 2.1 AA rule set (A + AA, 2.0 + 2.1). */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type Theme = "light" | "dark";

const HERO_RUN_ID = "TAS-88214";

/**
 * Run axe against the current page state and assert zero violations.
 * On failure, print rule id, impact, selector and the offending HTML snippet
 * so the fix loop is debuggable straight from the test output.
 */
async function expectNoViolations(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

  if (results.violations.length > 0) {
    const report = results.violations
      .map((violation) => {
        const nodes = violation.nodes
          .map(
            (node) =>
              `    selector: ${node.target.join(" ")}\n` +
              `    snippet:  ${node.html}\n` +
              `    ${node.failureSummary?.replaceAll("\n", "\n    ") ?? ""}`
          )
          .join("\n  ---\n");
        return `  ${violation.id} [impact: ${violation.impact}] — ${violation.help}\n${nodes}`;
      })
      .join("\n\n");
    console.log(`\n=== axe violations — ${context} ===\n${report}\n`);
  }

  expect(
    results.violations.map((violation) => violation.id),
    `${context}: expected zero WCAG violations`
  ).toEqual([]);
}

/**
 * Apply the theme via localStorage "tm-theme" before any document script runs
 * — the layout's no-FOUC inline script reads this key during HTML parsing, so
 * the class is correct from first paint. More robust than clicking the topbar
 * toggle (no hydration race, works on every route including deep links).
 */
async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem("tm-theme", value);
  }, theme);
}

/** Navigate and wait until data has loaded (all skeletons gone). */
async function gotoSettled(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await useTheme(page, theme);
    });

    test("home", async ({ page }) => {
      await gotoSettled(page, "/");
      await expectNoViolations(page, `/ (${theme})`);
    });

    test("runs list", async ({ page }) => {
      await gotoSettled(page, "/runs");
      await expectNoViolations(page, `/runs (${theme})`);
    });

    test("run detail — all tabs", async ({ page }) => {
      await gotoSettled(page, `/runs/${HERO_RUN_ID}`);
      // Default tab: signals.
      await expect(page.getByRole("tab", { name: /Signals/ })).toBeVisible();
      await expectNoViolations(page, `/runs/${HERO_RUN_ID} signals tab (${theme})`);

      /* The Explore tab exists only when the dev server runs with
         TM_EXPLORE=1 — start it flag-on for these scans. */
      for (const tab of [/^Files/, /Processed results/, /Journal/, /^Explore/] as const) {
        await page.getByRole("tab", { name: tab }).click();
        await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
        await expectNoViolations(page, `/runs/${HERO_RUN_ID} ${tab} tab (${theme})`);
      }
    });

    test("run lineage", async ({ page }) => {
      await gotoSettled(page, `/runs/${HERO_RUN_ID}/lineage`);
      await expectNoViolations(page, `/runs/${HERO_RUN_ID}/lineage (${theme})`);
    });

    test("work orders list", async ({ page }) => {
      await gotoSettled(page, "/work-orders");
      await expectNoViolations(page, `/work-orders (${theme})`);
    });

    test("work order detail", async ({ page }) => {
      await gotoSettled(page, "/work-orders/WO-2026-0847");
      await expectNoViolations(page, `/work-orders/WO-2026-0847 (${theme})`);
    });

    test("files list", async ({ page }) => {
      await gotoSettled(page, "/files");
      await expectNoViolations(page, `/files (${theme})`);
    });

    test("file detail", async ({ page }) => {
      // File ids are backend-generated — pick the first row from the list UI.
      await gotoSettled(page, "/files");
      /* Data rows only — the loading skeleton also renders tbody rows. */
      await page.locator("tbody tr:has(a)").first().click();
      await page.waitForURL(/\/files\/[^/]+$/);
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
      await expectNoViolations(page, `file detail (${theme})`);
    });

    test("signals list", async ({ page }) => {
      await gotoSettled(page, "/signals");
      await expectNoViolations(page, `/signals (${theme})`);
    });

    test("signal detail", async ({ page }) => {
      await gotoSettled(page, "/signals/HV_Batt_Cell_Temp_Max");
      await expectNoViolations(page, `/signals/HV_Batt_Cell_Temp_Max (${theme})`);
    });

    test("design system", async ({ page }) => {
      // The design-system page intentionally showcases skeleton components,
      // so waiting for zero skeletons would never settle — wait for the
      // static content instead.
      await page.goto("/design-system");
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expectNoViolations(page, `/design-system (${theme})`);
    });

    test("global search overlay (⌘K) with default groups", async ({ page }) => {
      await gotoSettled(page, "/");
      /* The helper matches the combobox role. The topbar button and the dialog
         input carry different wording, and the input text changed once already. */
      await openSearchViaTopbar(page);
      const dialog = page.getByRole("dialog");
      // Default (empty-query) groups populated from the entity lists.
      await expect(dialog.getByText("Test runs", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Work orders", { exact: true })).toBeVisible();
      await expectNoViolations(page, `⌘K search overlay (${theme})`);
    });

    test("mark-invalid dialog", async ({ page }) => {
      await gotoSettled(page, `/runs/${HERO_RUN_ID}`);
      await page.getByRole("button", { name: /Mark invalid/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoViolations(page, `mark-invalid dialog (${theme})`);
    });

    /* --- Table-filters feature: interactive UI states (Wave 2) --- */

    test("runs list — Status filter popover open", async ({ page }) => {
      await gotoSettled(page, "/runs");
      // Click the Status multi-select trigger to open the popover.
      await page
        .getByRole("button", { name: "Status", exact: true })
        .click();
      // Popover renders as an ARIA dialog (aria-haspopup="dialog").
      await expect(page.getByRole("dialog", { name: /Status filter/ })).toBeVisible();
      await expectNoViolations(page, `/runs Status popover open (${theme})`);
    });

    test("runs list — active filter pills", async ({ page }) => {
      await gotoSettled(page, "/runs");
      // Apply a status filter via the popover, then close it so the pills are the focus.
      await page
        .getByRole("button", { name: "Status", exact: true })
        .click();
      const popover = page.getByRole("dialog", { name: /Status filter/ });
      await expect(popover).toBeVisible();
      await popover.getByRole("checkbox", { name: /Invalid/ }).click();
      // Close the popover — click the Done button inside it.
      await popover.getByRole("button", { name: "Done" }).click();
      await expect(popover).toBeHidden();
      // Applied-filters row should have appeared with a pill.
      await expect(page.getByRole("list", { name: "Applied filters" })).toBeVisible();
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
      await expectNoViolations(page, `/runs active filter pills (${theme})`);
    });

    test("signals list — pager page 2", async ({ page }) => {
      await gotoSettled(page, "/signals");
      /* The seeded catalog holds 14 signals, so the default page of 20 shows
         them all and no pager appears. Ask for 10 a page, the way
         table-filters.spec.ts does, so a real page 2 exists to scan. */
      await page.getByLabel("Rows per page").selectOption("10");
      await page.waitForURL(/page_size=10/);
      const page2 = page.getByRole("button", { name: "Page 2" });
      await expect(page2).toBeVisible();
      await page2.click();
      // Wait for the fetch to settle before scanning.
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
      // The active page button carries aria-current="page" (see TablePager).
      await expect(page.locator('button[aria-current="page"]')).toHaveText("2");
      await expectNoViolations(page, `/signals pager page 2 (${theme})`);
    });

    test("signals list — page-size select focused", async ({ page }) => {
      await gotoSettled(page, "/signals");
      // Native <select> — focus it so axe scans it in the interactive state
      // (native controls can't be programmatically "opened" cross-browser).
      const rows = page.getByRole("combobox", { name: "Rows per page" });
      await expect(rows).toBeVisible();
      await rows.focus();
      await expectNoViolations(page, `/signals page-size select focused (${theme})`);
    });

    /* The loading state, scanned on purpose. `gotoSettled` waits for zero
       skeletons, so without this test nothing in the skeleton state is ever
       measured. Holding the list request open keeps the state on screen
       without a race. */
    test("runs list — loading skeletons", async ({ page }) => {
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      /* The browser calls the app's own proxy (lib/api/client.ts BASE_PATH).
         Hold only the list endpoint — facets and details pass through. */
      await page.route("**/api/proxy/test-runs*", async (route) => {
        if (new URL(route.request().url()).pathname.endsWith("/test-runs")) {
          await held;
          /* unroute() below auto-continues whatever is still pending, so by
             the time this handler wakes the route may already be handled —
             a second continue() would throw and fail the finished test. */
          await route.continue().catch(() => {});
          return;
        }
        await route.continue();
      });
      await page.goto("/runs");
      await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
      await expectNoViolations(page, `/runs loading skeletons (${theme})`);
      release();
      await page.unroute("**/api/proxy/test-runs*");
    });

    test("runs list — no rows match the filter", async ({ page }) => {
      // `q` is the search key — lib/table-state.ts reads it from the URL.
      await gotoSettled(page, "/runs?q=zzzzzzzzzz");
      await expect(page.getByRole("button", { name: "Clear everything" })).toBeVisible();
      await expectNoViolations(page, `/runs empty result (${theme})`);
    });

    /* --- Explore workbench: interactive states --- */

    /** Deep-link to Explore (exercises the ?tab= route) and wait for the
        workbench tablist so the async context fetch has settled. */
    async function gotoExplore(page: Page): Promise<void> {
      await gotoSettled(page, `/runs/${HERO_RUN_ID}?tab=explore`);
      await expect(
        page.getByRole("tablist", { name: "Explore workbench tabs" })
      ).toBeVisible();
    }

    test("explore — schema rail and history docked open", async ({ page }) => {
      await gotoExplore(page);
      // Both docks open at once: schema left, panes center, history right.
      await page.getByRole("button", { name: "Schema", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Close schema" })
      ).toBeVisible();
      await page.getByRole("button", { name: /^History/ }).click();
      await expect(
        page.getByRole("region", { name: "Query history" })
      ).toBeVisible();
      await expectNoViolations(page, `explore docked schema + history (${theme})`);
    });

    test("explore — new-tab menu open", async ({ page }) => {
      await gotoExplore(page);
      await page.getByRole("button", { name: "New tab" }).click();
      await expect(
        page.getByRole("menuitem", { name: /SQL query/ })
      ).toBeVisible();
      await expectNoViolations(page, `explore new-tab menu (${theme})`);
    });

    test("explore — tab rename input active", async ({ page }) => {
      await gotoExplore(page);
      await page.getByRole("tab", { name: "SQL query 1" }).dblclick();
      const rename = page.getByRole("textbox", { name: "Rename tab" });
      await expect(rename).toBeVisible();
      await expectNoViolations(page, `explore tab rename input (${theme})`);
    });

    /* --- FR-DM-079a autocomplete surfaces: open-state scans --- */

    test("edit-run dialog — work-order combobox popup open", async ({ page }) => {
      await gotoSettled(page, `/runs/${HERO_RUN_ID}`);
      await page.getByRole("button", { name: "Edit metadata" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // Clicking the combobox input opens the popup over the whole mirror.
      await dialog.getByRole("combobox", { name: /Work order/ }).click();
      await expect(page.getByRole("option").first()).toBeVisible();
      /* The popup fades in (data-open:animate-in, 100ms). When axe samples
         mid-fade it blends the half-transparent option text into the layers
         beneath and reports a contrast failure the settled popup does not
         have (9:1 measured at rest). Wait for the fade to finish first. */
      await expect(page.locator('[data-slot="combobox-content"]')).toHaveCSS("opacity", "1");
      await expectNoViolations(page, `edit-run work-order combobox open (${theme})`);
    });

    test("signals list — Unit filter popover with search open", async ({ page }) => {
      /* The search box appears past ~8 options and the seed holds 6 units.
         Grow the facet the way a person would: corrected units through
         PATCH /signals/{name} (contract §17) — the exact flow the facets
         route exists for. The mock db is in-memory, so the change lasts
         until the dev server restarts, and a re-run is an idempotent no-op. */
      const token = process.env.TM_API_TOKEN ?? "tm-demo-4711";
      for (const [name, unit] of [
        ["HV_Batt_Cell_Temp_Min", "K"],
        ["Chamber_Ambient_Temp", "°F"],
        ["EM_Shaft_Torque", "Nm"],
      ] as const) {
        const response = await page.request.patch(
          `/api/v1/signals/${encodeURIComponent(name)}`,
          {
            headers: { authorization: `Bearer ${token}` },
            data: { unit, actor: "axe-suite" },
          }
        );
        expect(response.ok(), `PATCH ${name} → ${unit}`).toBeTruthy();
      }
      await gotoSettled(page, "/signals");
      await page.getByRole("button", { name: "Unit", exact: true }).click();
      const popover = page.getByRole("dialog", { name: /Unit filter/ });
      await expect(popover).toBeVisible();
      const search = popover.getByRole("searchbox", { name: /Search unit options/ });
      await search.fill("°");
      await expectNoViolations(page, `/signals Unit popover with search (${theme})`);
    });
  });
}
