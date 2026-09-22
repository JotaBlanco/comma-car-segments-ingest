import { expect, test, type Page } from "@playwright/test";
import {
  HERO_RUN_ID,
  SYNC_WO_ID,
  metaLabelRow,
  resetDb,
  sidebarSyncState,
  syncSwitch,
} from "./support/helpers";

/**
 * THE stage rehearsal: the full demo script as one serial journey,
 * executed twice in a single test to prove the demo is rehearsable.
 *
 * The toggle restores nothing. A registry never un-remembers, so toggle-off
 * only stops the sync and keeps every row. The test hook `POST /api/test/reset`
 * puts the seed back between the two cycles.
 */

test.beforeEach(async ({ request }) => {
  await resetDb(request);
});

async function runDemoCycle(page: Page, cycle: number): Promise<void> {
  await test.step(`cycle ${cycle}: home opens amber`, async () => {
    await page.goto("/");
    await expect(sidebarSyncState(page)).toHaveText("offline");

    const awaitingRow = page.getByRole("link", { name: /Runs awaiting work order/ });
    await expect(awaitingRow).toBeVisible();
    await expect(awaitingRow).toContainText("1");
    await expect(page.getByRole("link", { name: /Quarantined files/ })).toContainText("2");
    await expect(page.getByRole("link", { name: /Invalid-flagged runs/ })).toContainText("1");

    /* The row is a plain <tr> whose first cell links the run id, so pick the
       row by its text and assert the link inside it. */
    const heroRow = page.locator("tbody tr").filter({ hasText: new RegExp(HERO_RUN_ID) });
    await expect(heroRow.getByRole("link", { name: HERO_RUN_ID })).toBeVisible();
    await expect(heroRow.getByText("Awaiting work order")).toBeVisible();
  });

  await test.step(`cycle ${cycle}: attention row deep-links to the awaiting filter`, async () => {
    await page.getByRole("link", { name: /Runs awaiting work order/ }).click();
    await page.waitForURL("/runs?status=awaiting_work_order");
    /* Under strict set-equality (spec §3), the one-element `{awaiting_work_order}` status
       set doesn't match any preset (All / Needs attention / Invalid) — no segment lights up.
       Visible state lives in the ActiveFilterPills row instead: assert the status pill. */
    const pillsRow = page.getByRole("list", { name: "Applied filters" });
    await expect(pillsRow.getByRole("listitem").filter({ hasText: "Awaiting work order" })).toBeVisible();
    /* And no segment button is in the pressed state. */
    await expect(
      page.getByRole("button", { name: "Awaiting work order", pressed: true }),
    ).toHaveCount(0);
    await expect(page.locator("tbody tr:has(a)")).toHaveCount(1);
    await expect(page.getByRole("link", { name: new RegExp(HERO_RUN_ID) })).toBeVisible();
  });

  await test.step(`cycle ${cycle}: run detail shows the amber unsynced state`, async () => {
    await page.getByRole("link", { name: new RegExp(HERO_RUN_ID) }).click();
    await page.waitForURL(`/runs/${HERO_RUN_ID}`);

    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByText("not yet synced")).toHaveCount(2);
    await expect(page.getByText("Awaiting work order", { exact: true })).toBeVisible();

    /* Every field carries its source: manual on operator, embedded on rig. */
    await expect(metaLabelRow(page, "Operator").getByText("manual", { exact: true })).toBeVisible();
    await expect(metaLabelRow(page, "Rig").getByText("embedded", { exact: true })).toBeVisible();
    /* Work order renders the awaiting-sync empty state. */
    await expect(page.getByText("awaiting sync").first()).toBeVisible();
  });

  await test.step(`cycle ${cycle}: lineage shows dashed unsynced nodes + provenance`, async () => {
    await page.getByRole("link", { name: /Lineage/ }).click();
    await page.waitForURL(`/runs/${HERO_RUN_ID}/lineage`);
    /* Heading role — plain text would also match Next's route announcer. */
    await expect(page.getByRole("heading", { name: `Lineage — ${HERO_RUN_ID}` })).toBeVisible();
    /* Work order + definition nodes render the not-yet-synced dashed state. */
    await expect(page.getByText("not yet synced")).toHaveCount(2);
    /* The processed-result provenance card. */
    await expect(page.getByText("Provenance — mandatory")).toBeVisible();
    await expect(page.getByText(/bat-post 2\.3\.1/)).toBeVisible();
    await expect(page.getByText("e.lindqvist")).toBeVisible();
  });

  await test.step(`cycle ${cycle}: toggle on turns the world green without reload`, async () => {
    await page.goBack();
    await page.waitForURL(`/runs/${HERO_RUN_ID}`);

    await syncSwitch(page).click();
    await expect(
      page.getByText("Planning sync online — 5 work orders mirrored, 1 run backfilled"),
    ).toBeVisible();

    /* All of the below must appear via query invalidation — no reload. */
    await expect(page.getByText("Linked", { exact: true })).toBeVisible();
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByRole("link", { name: new RegExp(SYNC_WO_ID) })).toBeVisible();
    await expect(crumbs.getByText("not yet synced")).toHaveCount(0);
    await expect(
      metaLabelRow(page, "Work order").getByText("api:planning", { exact: true }),
    ).toBeVisible();
    await expect(
      metaLabelRow(page, "Test definition").getByText("api:planning", { exact: true }),
    ).toBeVisible();

    /* Journal count bumps 3 → 4 and the backfill entry sits on top. */
    const journalTab = page.getByRole("tab", { name: /Journal/ });
    await expect(journalTab).toContainText("4");
    await journalTab.click();
    const topEntry = page.getByRole("tabpanel").locator("div.relative").first();
    await expect(topEntry).toContainText("run.work_order");
    await expect(topEntry).toContainText("(empty)");
    await expect(topEntry).toContainText(SYNC_WO_ID);
    await expect(topEntry).toContainText("api:planning");
  });

  await test.step(`cycle ${cycle}: home attention row is gone`, async () => {
    await page.getByRole("link", { name: /^Home$/ }).click();
    await page.waitForURL("/");
    await expect(sidebarSyncState(page)).toHaveText("online");
    await expect(page.getByRole("link", { name: /Runs awaiting work order/ })).toHaveCount(0);
    /* The other attention rows are untouched. */
    await expect(page.getByRole("link", { name: /Quarantined files/ })).toContainText("2");
  });

  await test.step(`cycle ${cycle}: work-orders list shows the newly mirrored WO`, async () => {
    const sidebar = page.locator("nav").filter({ hasText: "Planning sync:" });
    await sidebar.getByRole("link", { name: /Work orders/ }).click();
    await page.waitForURL("/work-orders");
    await expect(page.getByRole("link", { name: new RegExp(SYNC_WO_ID) })).toBeVisible();
  });

  await test.step(`cycle ${cycle}: toggle off stops the sync and deletes nothing`, async () => {
    await syncSwitch(page).click();
    await expect(page.getByText("Planning sync offline — no new data arrives")).toBeVisible();
    await expect(sidebarSyncState(page)).toHaveText("offline");
    /* The mirrored WO stays in the list. A registry never un-remembers. */
    await expect(page.getByRole("link", { name: new RegExp(SYNC_WO_ID) })).toBeVisible();

    await page.goto(`/runs/${HERO_RUN_ID}`);
    await expect(page.getByText("Awaiting work order", { exact: true })).toHaveCount(0);
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByRole("link", { name: new RegExp(SYNC_WO_ID) })).toBeVisible();
    await expect(crumbs.getByText("not yet synced")).toHaveCount(0);
    /* The backfill entry stays too — 4 entries, not the seed's 3. */
    await expect(page.getByRole("tab", { name: /Journal/ })).toContainText("4");
  });
}

test("the full stage script is rehearsable twice over", async ({ page, request }) => {
  test.setTimeout(300_000);
  await runDemoCycle(page, 1);
  /* The toggle restores nothing, so the seed comes back through the test hook. */
  await resetDb(request);
  await runDemoCycle(page, 2);
});
