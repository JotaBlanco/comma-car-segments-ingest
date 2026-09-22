import { expect, test } from "@playwright/test";
import {
  HERO_RUN_ID,
  openSearchViaKeyboard,
  openSearchViaTopbar,
  resetDb,
  searchInput,
} from "./support/helpers";

test.beforeEach(async ({ request }) => {
  await resetDb(request);
});

test("cmd-k opens the overlay; Enter navigates to the top run hit", async ({ page }) => {
  await page.goto("/");
  await openSearchViaKeyboard(page);

  await searchInput(page).fill("88214");
  /* Grouped results: the hero run plus its files (matched by run id). */
  const dialog = page.getByRole("dialog");
  /* The overlay now shows default grouped results (Test runs / Work orders / Files /
     Signals) before typing — after typing, the search groups replace them. Wait on the
     search-mode group heading ("Runs", exact — the default heading is "Test runs"). */
  await expect(dialog.getByText("Runs", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Files", { exact: true })).toBeVisible();
  /* Groups are ordered runs → WOs → files → signals; file subtitles also
     carry the run id, so take the first (run) hit. */
  const runOption = page.getByRole("option", { name: new RegExp(HERO_RUN_ID) }).first();
  await expect(runOption).toBeVisible();
  await expect(runOption.getByText("Awaiting work order")).toBeVisible();

  /* The first option is pre-selected — Enter opens it. Under load, cmdk needs a beat
     to re-select the first item after the groups transition from default → search
     results; nudge with an explicit ArrowDown+ArrowUp to guarantee selection. */
  await searchInput(page).press("ArrowDown");
  await searchInput(page).press("ArrowUp");
  await searchInput(page).press("Enter");
  await page.waitForURL(`/runs/${HERO_RUN_ID}`);
  await expect(page.getByText("HV battery thermal cycling").first()).toBeVisible();
});

test("each entity type routes to its detail screen", async ({ page }) => {
  await page.goto("/");

  /* Run */
  await openSearchViaTopbar(page);
  await searchInput(page).fill("88213");
  await page.getByRole("option", { name: /TAS-88213/ }).first().click();
  await page.waitForURL("/runs/TAS-88213");
  await expect(page.getByText("E-machine efficiency map").first()).toBeVisible();

  /* Work order */
  await openSearchViaTopbar(page);
  await searchInput(page).fill("0847");
  /* .first(): test-definition results also carry their work order's id, so the
     regex can match several options once live results replace the defaults. */
  await page.getByRole("option", { name: /WO-2026-0847/ }).first().click();
  await page.waitForURL("/work-orders/WO-2026-0847");
  await expect(page.getByText("E-machine efficiency characterisation").first()).toBeVisible();

  /* File — navigates by opaque file_id, not the displayed filename. */
  await openSearchViaTopbar(page);
  await searchInput(page).fill("inca_cal");
  await page.getByRole("option", { name: /inca_cal_20260814_0941\.mf4/ }).click();
  await page.waitForURL("/files/f-41bb63e0-7c25-4d98-b1f4-08a3d5c2e917");
  await expect(page.getByText("inca_cal_20260814_0941.mf4").first()).toBeVisible();

  /* Signal */
  await openSearchViaTopbar(page);
  await searchInput(page).fill("Shaft_Torque");
  await page.getByRole("option", { name: /EM_Shaft_Torque/ }).click();
  await page.waitForURL("/signals/EM_Shaft_Torque");
  await expect(page.getByText("Dyno shaft torque, HBM flange").first()).toBeVisible();
});

test("a nonsense query shows the no-matches state", async ({ page }) => {
  await page.goto("/");
  await openSearchViaTopbar(page);
  await searchInput(page).fill("xyzzy-no-such-thing");
  /* Copy uses typographic quotes — match on the stable part. */
  await expect(page.getByText(/No matches for .xyzzy-no-such-thing./)).toBeVisible();
});

test("a signal result carrying ° in its unit navigates without crash", async ({ page }) => {
  /* No seeded signal has ° in its *name*; the ° appears in the displayed
     unit (°C) of e.g. HV_Batt_Cell_Temp_Max — assert that result renders
     and navigates cleanly. */
  await page.goto("/");
  await openSearchViaTopbar(page);
  await searchInput(page).fill("Cell_Temp_Max");
  const option = page.getByRole("option", { name: /HV_Batt_Cell_Temp_Max/ });
  await expect(option).toContainText("°C");
  await option.click();
  await page.waitForURL("/signals/HV_Batt_Cell_Temp_Max");
  await expect(page.getByText("Hottest cell temperature across pack").first()).toBeVisible();
  await expect(page.getByText("°C").first()).toBeVisible();
});
