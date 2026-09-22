/**
 * Registry assistant e2e (mock mode — AS-6).
 *
 * The mock chat route replays the deterministic sensor script from
 * lib/mock/assistant-script.ts, so the assertions here are exact:
 *  - ⌘J opens the panel (once the status probe has shown the Ask trigger);
 *  - the sensor question streams three hit cards and the filtered-view
 *    deep link;
 *  - clicking the deep link lands on /runs with the scripted query params.
 *
 * Per-test db reset follows the deep-links.spec.ts pattern.
 */

import { expect, test, type Page } from "@playwright/test";
import { resetDb } from "./support/helpers";

test.beforeEach(async ({ request }) => {
  await resetDb(request);
});

function panel(page: Page) {
  return page.getByRole("complementary", { name: "Assistant" });
}

/** Open the panel via the keyboard: Meta+J first, Control+J fallback. */
async function openAssistantViaKeyboard(page: Page): Promise<void> {
  // The shortcut is gated on GET /assistant/status — wait for the trigger.
  await expect(page.getByRole("button", { name: /Ask the registry|Ask ⌘J|^Ask/ })).toBeVisible();
  await page.keyboard.press("Meta+KeyJ");
  if (!(await panel(page).isVisible())) {
    await page.keyboard.press("Control+KeyJ");
  }
  await expect(panel(page)).toBeVisible();
}

test("⌘J opens the panel; the sensor question answers with hits and a deep link", async ({
  page,
}) => {
  await page.goto("/");
  await openAssistantViaKeyboard(page);

  // The trust contract is stated where the user reads it.
  await expect(panel(page).getByText("Reads the registry. Never edits.")).toBeVisible();

  await panel(page)
    .getByLabel("Ask about runs, files, signals, work orders")
    .fill("Which tests failed because of sensor issues on EX90 in the last month?");
  await panel(page).getByRole("button", { name: "Send" }).click();

  // Three server-hydrated hit cards from the scripted frames.
  await expect(panel(page).getByTestId("assistant-hit")).toHaveCount(3);
  await expect(panel(page).getByText("TAS-88012")).toBeVisible();
  await expect(panel(page).getByText("TAS-87996")).toBeVisible();
  await expect(panel(page).getByText("TAS-87911")).toBeVisible();

  // The payoff: a real URL into a real filtered screen.
  const deeplink = panel(page).getByTestId("assistant-deeplink");
  await expect(deeplink).toBeVisible();
  await expect(deeplink).toContainText("Open filtered view");

  await deeplink.click();
  await expect(page).toHaveURL(/\/runs\?status=invalid&project=EX90&q=sensor/);
});
