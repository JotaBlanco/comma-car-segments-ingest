import { expect, test } from "@playwright/test";
import { COMPLETE_RUN_ID, resetDb, signInPortal } from "./support/helpers";

/**
 * Mark-invalid flow on TAS-88213 (a complete, non-hero run — never
 * collides with the planning-sync beat).
 */

test.beforeEach(async ({ page, request }) => {
  await resetDb(request);
  // The flag names the person who raised it, so the control needs an identity.
  await signInPortal(page);
});

test("empty reason is rejected inline with no state change", async ({ page }) => {
  await page.goto(`/runs/${COMPLETE_RUN_ID}`);
  await expect(page.getByText("Linked", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Mark invalid/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`Mark ${COMPLETE_RUN_ID} as invalid`)).toBeVisible();

  await dialog.getByRole("button", { name: "Flag invalid" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A reason is required.");
  /* Dialog stays open, nothing was flagged. */
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Linked", { exact: true })).toBeVisible();
  await expect(page.getByText("Flagged invalid")).toHaveCount(0);

  /* Home invalid count untouched (seed has exactly one invalid run). */
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Invalid-flagged runs/ })).toContainText("1");
});

test("a valid reason flags the run everywhere", async ({ page }) => {
  const reason = "Coolant flow sensor drifted after cycle 14 — data unusable.";
  await page.goto(`/runs/${COMPLETE_RUN_ID}`);
  await page.getByRole("button", { name: /Mark invalid/ }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason for flagging invalid").fill(reason);
  await dialog.getByRole("button", { name: "Flag invalid" }).click();

  await expect(
    page.getByText(`${COMPLETE_RUN_ID} flagged invalid — journalled with reason`),
  ).toBeVisible();
  await expect(dialog).toBeHidden();

  /* Red banner + red badge on the detail. */
  const banner = page.getByRole("alert").filter({ hasText: "Flagged invalid" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(reason);
  await expect(page.getByText("Invalid", { exact: true })).toBeVisible();

  /* Journal entry with the reason (seed has none for this run: 0 → 1). */
  const journalTab = page.getByRole("tab", { name: /Journal/ });
  await expect(journalTab).toContainText("1");
  await journalTab.click();
  const entry = page.getByRole("tabpanel").locator("div.relative").first();
  await expect(entry).toContainText("run.invalid_flag");
  await expect(entry).toContainText(reason);

  /* Home invalid count bumps 1 → 2 and the filter lists the run. */
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Invalid-flagged runs/ })).toContainText("2");
  await page.goto("/runs?status=invalid");
  await expect(page.getByRole("link", { name: new RegExp(COMPLETE_RUN_ID) })).toBeVisible();
});

test("a second flag attempt is handled gracefully", async ({ page }) => {
  await page.goto(`/runs/${COMPLETE_RUN_ID}`);

  /* Open the dialog first, then flag the run out from under it (409 race). */
  await page.getByRole("button", { name: /Mark invalid/ }).click();
  const dialog = page.getByRole("dialog");
  const apiResponse = await page.request.post(
    `/api/proxy/test-runs/${COMPLETE_RUN_ID}/invalid-flag`,
    { data: { reason: "Flagged concurrently by another engineer.", actor: "a.bergstrom" } },
  );
  expect(apiResponse.ok()).toBe(true);

  await dialog.getByLabel("Reason for flagging invalid").fill("Duplicate flag attempt.");
  await dialog.getByRole("button", { name: "Flag invalid" }).click();

  /* The 409 surfaces as a user-visible toast and the dialog closes — no crash. */
  await expect(page.getByText("This run is already flagged invalid")).toBeVisible();
  await expect(dialog).toBeHidden();

  /* The API confirms the conflict semantics. */
  const second = await page.request.post(
    `/api/proxy/test-runs/${COMPLETE_RUN_ID}/invalid-flag`,
    { data: { reason: "And again.", actor: "a.bergstrom" } },
  );
  expect(second.status()).toBe(409);
  expect((await second.json()).code).toBe("already_flagged");

  /* Once flagged, the UI removes the re-flag entry point entirely. */
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Flagged invalid" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Mark invalid/ })).toHaveCount(0);
});
