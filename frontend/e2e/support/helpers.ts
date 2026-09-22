import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/** Hero seed constants (mirrors lib/mock/seed.ts). */
export const HERO_RUN_ID = "TAS-88214";
export const SYNC_WO_ID = "WO-2026-0851";
export const COMPLETE_RUN_ID = "TAS-88213";
export const QUARANTINED_FILE = "em_eff_20260813_1726.mf4";
export const MISSING_UNIT_SIGNALS = ["Chamber_Humidity", "EM_Shaft_Torque"] as const;

/**
 * Reset the server's in-memory mock db to the seed state.
 * Served only when the server runs with TM_TEST_HOOKS=1.
 */
export async function resetDb(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/test/reset");
  expect(response.ok(), "POST /api/test/reset should succeed (TM_TEST_HOOKS=1)").toBe(true);
}

/**
 * The topbar planning-sync switch (visible on every screen; the app's only
 * switch). Base UI puts the aria-label on an inner element, so the exposed
 * accessible name comes from the "Planning sync" label — match by role alone.
 */
export function syncSwitch(page: Page): Locator {
  return page.getByRole("switch");
}

/** The global-search overlay input (only present while the dialog is open). */
export function searchInput(page: Page): Locator {
  /* Match the role, not the placeholder. The topbar button and the dialog
     input carry different wording, and the input text changed once already. */
  return page.getByRole("dialog").getByRole("combobox");
}

/** Open the ⌘K overlay via the topbar trigger button. */
export async function openSearchViaTopbar(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Search runs, files, signals, work orders/ }).click();
  await expect(searchInput(page)).toBeVisible();
}

/**
 * Open the ⌘K overlay via the keyboard: Meta+K first, Control+K fallback
 * (the app listens for either modifier).
 */
export async function openSearchViaKeyboard(page: Page): Promise<void> {
  await page.keyboard.press("Meta+KeyK");
  if (!(await searchInput(page).isVisible())) {
    await page.keyboard.press("Control+KeyK");
  }
  await expect(searchInput(page)).toBeVisible();
}

/**
 * A MetaGrid cell's label row (uppercase label + optional source badge),
 * e.g. metaLabelRow(page, "Operator") to assert the "manual" badge next to it.
 */
export function metaLabelRow(page: Page, label: string): Locator {
  return page.locator("div.uppercase").filter({ hasText: label });
}

/** The sidebar footer's planning-sync state ("online" / "offline"). */
export function sidebarSyncState(page: Page): Locator {
  return page
    .locator("nav")
    .filter({ hasText: "Planning sync:" })
    .locator("b");
}

/**
 * Sign a Quix Portal identity in, for this page only.
 *
 * Every manual write names the person who made it, so a write control stays
 * disabled until a Portal profile resolves. The test server holds no Portal,
 * so the test answers the two profile calls itself and plants the token the
 * browser reads on start.
 */
export async function signInPortal(page: Page, displayName = "Erika Lindqvist"): Promise<void> {
  const [firstName, ...rest] = displayName.split(" ");
  await page.route("**/profile", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        userId: "u-e2e",
        email: "e2e@volvo.com",
        firstName,
        lastName: rest.join(" "),
      }),
    }),
  );
  await page.route("**/organisations/current", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  /* The proxy sends the viewer's Portal token to the API and drops the shared
     one. The mock backend verifies no token with a Portal, so it accepts the
     shared token alone. The rig therefore signs in with that same value, and
     every data call still passes. A real Portal verifies a real token. */
  await page.addInitScript((token: string) => {
    window.localStorage.setItem("tm.portal.token", token);
  }, "tm-demo-4711");
}
