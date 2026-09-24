import { expect, test } from "@playwright/test";
import { HERO_RUN_ID, SYNC_WO_ID, resetDb } from "./support/helpers";

/**
 * UC-005 — Trace test history.
 *
 * One person walks the registry from the top down, the way the demo walks it:
 * work order → test definition → test run → file, and then the run's lineage
 * and the run's journal. Every step asserts content the chain produces — an
 * id, a title, a checksum, an href, a journal actor — so a broken link fails
 * the walk instead of a thinner page passing it.
 *
 * The definition is a full node of the walk. It carries its own screen, so
 * step 3 clicks through it and reads its work order and its runs.
 *
 * The walk uses the hero chain, because it is the only seeded chain that
 * carries content on every link at once: three files on the run, ingestion
 * events on the file, a processed result on the lineage, and entries in the
 * run journal. The planning sync pass is setup here and not the subject —
 * it mirrors WO-2026-0851 and backfills the hero run, driven directly through
 * `POST /api/v1/planning-sync/trigger` rather than a UI control.
 */

/** The definition the planning sync links to the hero run (lib/mock/seed.ts). */
const SYNC_TD_ID = "TD-BAT-114";
const DEFINITION_TITLE = "HV battery thermal cycling · −20 °C → +40 °C";
const HERO_FILE_ID = "f-9a41c8f2-6d0b-4e17-a35c-72d9e814b061";
const HERO_FILENAME = "bat_cyc_20260814_0941.mf4";
const HERO_CHECKSUM = "9f2c8a41d6e0b3f73d5a1e8c04d9b6273fa08e51c47d92e6b30f14c2ad90e1a7";

test.beforeEach(async ({ request }) => {
  await resetDb(request);
});

test("a person drills work order → definition → run → file, then reads lineage and journal", async ({
  page,
}) => {
  /* The walk crosses six screens and downloads a file. */
  test.setTimeout(180_000);

  await test.step("setup: the planning sync mirrors the work order", async () => {
    /* Through the proxy, like the app's own client (lib/api/client.ts) — the
       proxy attaches the shared TM_API_TOKEN server-side; the browser never
       holds it. */
    const response = await page.request.post("/api/proxy/planning-sync/trigger");
    expect(response.ok()).toBe(true);
    await page.goto("/");
  });

  await test.step("step 1: the work-orders list opens the work order", async () => {
    /* Exact match: the home page also links to /work-orders from a
       "Work orders mirrored" stat card, whose accessible name would also
       match a loose /Work orders/ pattern. */
    await page.getByRole("link", { name: "Work orders", exact: true }).click();
    await page.waitForURL("/work-orders");

    await page.getByRole("link", { name: new RegExp(SYNC_WO_ID) }).click();
    await page.waitForURL(`/work-orders/${SYNC_WO_ID}`);

    /* The planning system owns these fields, so the screen prints them
       unchanged and marks itself a read-only mirror. */
    await expect(page.getByText("HV battery thermal validation — winter cycle").first()).toBeVisible();
    await expect(page.getByText("L. Åkesson · Battery")).toBeVisible();
    await expect(page.getByText("P1 — expedite")).toBeVisible();
    await expect(page.getByText(/Read-only mirror — owned by the planning system/)).toBeVisible();
  });

  await test.step("step 2: the work order opens its test definition", async () => {
    /* Both tables carry a definition id, so pick each table by a column
       header that only it has. */
    const definitionsTable = page
      .locator("table")
      .filter({ has: page.getByRole("columnheader", { name: "Planned runs" }) });

    const definitionRow = definitionsTable.getByRole("row").filter({ hasText: SYNC_TD_ID });
    await expect(definitionRow).toContainText("HV battery thermal cycling");
    await expect(definitionRow).toContainText("+40 °C");
    /* 4 runs planned, 1 arrived — the plan is still open, so the row is amber. */
    await expect(definitionRow).toContainText("4");
    await expect(definitionRow).toContainText("1");
    await expect(definitionRow.getByText("Awaiting data")).toBeVisible();

    /* The work order's own runs table states the definition each run carries,
       so both tables agree on the edge the walk is about to follow. */
    const runsTable = page
      .locator("table")
      .filter({ has: page.getByRole("columnheader", { name: "Arrived" }) });
    /* The link role now names only the run id in the first cell, so read the
       definition id off the row (its row role is back). */
    await expect(
      runsTable.getByRole("row").filter({ hasText: new RegExp(HERO_RUN_ID) }),
    ).toContainText(SYNC_TD_ID);

    /* The definition id is a link, so the walk goes through the definition
       instead of around it. */
    await definitionRow.getByRole("link", { name: SYNC_TD_ID }).click();
    await page.waitForURL(`/definitions/${SYNC_TD_ID}`);
  });

  await test.step("step 3: the definition screen opens its test run", async () => {
    /* The planning system owns this screen too, so it prints the mirrored
       fields unchanged and names who owns them. */
    await expect(page.getByText(DEFINITION_TITLE).first()).toBeVisible();
    await expect(page.getByText(/Read-only mirror — owned by the planning system/)).toBeVisible();
    await expect(page.getByText(/never editable here/)).toBeVisible();

    /* The breadcrumb closes the chain upwards: the definition names the work
       order it is mirrored under, and that chip is a link. */
    const defCrumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(defCrumbs.getByRole("link", { name: /WO-2026-\d{4}/ })).toHaveAttribute(
      "href",
      /^\/work-orders\/WO-2026-\d{4}$/,
    );
    await expect(defCrumbs.getByText(SYNC_TD_ID)).toBeVisible();

    /* The runs panel is the edge down. The hero run sits in it, and the row
       carries the rig the run came off. */
    const definitionRuns = page
      .locator("table")
      .filter({ has: page.getByRole("columnheader", { name: "Rig" }) });
    const heroRow = definitionRuns.getByRole("row").filter({ hasText: new RegExp(HERO_RUN_ID) });
    await expect(heroRow).toContainText("RIG-04");
    await heroRow.getByRole("link", { name: new RegExp(HERO_RUN_ID) }).click();
    await page.waitForURL(`/runs/${HERO_RUN_ID}`);

    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByRole("link", { name: new RegExp(SYNC_WO_ID) })).toBeVisible();
    /* The run's definition chip addresses the screen the walk just came from. */
    await expect(crumbs.getByRole("link", { name: new RegExp(SYNC_TD_ID) })).toHaveAttribute(
      "href",
      `/definitions/${SYNC_TD_ID}`,
    );
    await expect(page.getByText("HV battery thermal cycling").first()).toBeVisible();
    await expect(page.getByText("Linked", { exact: true })).toBeVisible();
  });

  await test.step("step 4: the run opens its file", async () => {
    await page.getByRole("tab", { name: /Files/ }).click();
    const fileRow = page.getByRole("row").filter({ hasText: HERO_FILENAME });
    /* The row prints a shortened checksum — first four and last four hex
       digits of the same sha256 the detail screen prints in full. */
    await expect(fileRow).toContainText(/sha256:9f2c.+e1a7/);
    await expect(fileRow).toContainText("96");
    await expect(fileRow.getByText("Registered")).toBeVisible();

    await fileRow.getByRole("link", { name: HERO_FILENAME }).click();
    await page.waitForURL(`/files/${HERO_FILE_ID}`);
    await expect(page.getByText(`sha256:${HERO_CHECKSUM}`)).toBeVisible();
    await expect(
      page.getByText("blob://test-manager/landing/rig-04/2026/08/14/bat_cyc_20260814_0941.mf4"),
    ).toBeVisible();
    await expect(page.getByText("ing-20260814-0941-77c2")).toBeVisible();

    /* The file screen closes the chain upwards: work order, definition and
       run all sit in its breadcrumb. */
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByRole("link", { name: new RegExp(SYNC_WO_ID) })).toBeVisible();
    await expect(crumbs.getByText(SYNC_TD_ID)).toBeVisible();
    await expect(crumbs.getByRole("link", { name: new RegExp(HERO_RUN_ID) })).toBeVisible();
  });

  await test.step("step 5: the download writes its own audit entry", async () => {
    /* The ingestion timeline is the file's own journal. It starts with the
       four events the ingestion wrote. The file detail now ALSO renders the
       History panel over the same journal, so the same event appears twice
       on the page — `.first()` pins the timeline's copy. */
    const detectedEntry = page
      .locator("div.relative")
      .filter({ hasText: "file.detected" })
      .first();
    await expect(detectedEntry).toContainText(`${HERO_FILENAME} arrived through mf4-import.`);
    /* The pipeline writes every file event as "ingestion" (tm-connector
       TM_ACTOR). No component called file-watcher exists. */
    await expect(detectedEntry).toContainText("ingestion");
    await expect(page.getByText("sha256 matches manifest — file admitted for parsing.").first()).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download · / }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(HERO_FILENAME);
    await expect(page.getByText(/Downloaded · checksum verified/)).toBeVisible();

    /* The screen does not refetch after a download, so read the timeline
       again. The audit entry names the caller and the file it served. */
    await page.reload();
    /* The event renders in both the ingestion timeline and the History
       panel — `.first()` pins the timeline's copy, same as file.detected. */
    const auditEntry = page
      .locator("div.relative")
      .filter({ hasText: "file.downloaded" })
      .first();
    await expect(auditEntry).toContainText("static token holder");
    await expect(auditEntry).toContainText(HERO_FILENAME);
  });

  await test.step("step 6: the lineage shows the whole chain and navigates back up", async () => {
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name: new RegExp(HERO_RUN_ID) })
      .click();
    await page.waitForURL(`/runs/${HERO_RUN_ID}`);

    await page.getByRole("link", { name: /Lineage/ }).click();
    await page.waitForURL(`/runs/${HERO_RUN_ID}/lineage`);
    await expect(page.getByRole("heading", { name: `Lineage — ${HERO_RUN_ID}` })).toBeVisible();

    /* Every node the walk passed, now on one screen. */
    const workOrderNode = page.getByRole("link", { name: new RegExp(SYNC_WO_ID) });
    await expect(workOrderNode).toContainText("HV battery thermal validation — winter cycle");
    /* The definition node addresses the same screen step 3 walked through, so
       the lineage and the breadcrumb agree on where a definition lives. */
    await expect(page.getByRole("link", { name: new RegExp(SYNC_TD_ID) })).toHaveAttribute(
      "href",
      `/definitions/${SYNC_TD_ID}`,
    );
    /* The crumbs link the run too, so pick the node card by its label. */
    const runNode = page.getByRole("link", { name: new RegExp(`Test run.+${HERO_RUN_ID}`) });
    await expect(runNode).toContainText("3 files · 142 signals");
    /* The file node addresses the same opaque id step 4 navigated to. */
    await expect(page.getByRole("link", { name: new RegExp(HERO_FILENAME) })).toHaveAttribute(
      "href",
      `/files/${HERO_FILE_ID}`,
    );
    /* The processed result names the tool that made it and resolves its
       input file ids back to filenames. */
    await expect(page.getByText("thermal_summary_v1.parquet")).toBeVisible();
    await expect(page.getByText(/bat-post 2\.3\.1/)).toBeVisible();
    await expect(page.getByText("e.lindqvist")).toBeVisible();
    await expect(page.getByText(new RegExp(`${HERO_FILENAME} · chamber_log_0941\\.csv`))).toBeVisible();

    /* The chain is navigable in both directions — the work-order node leads
       back to the screen the walk started on. */
    await workOrderNode.click();
    await page.waitForURL(`/work-orders/${SYNC_WO_ID}`);
    await expect(page.getByText("HV battery thermal validation — winter cycle").first()).toBeVisible();
  });

  await test.step("step 7: the run journal names who changed what, and when", async () => {
    await page.goBack();
    await page.waitForURL(`/runs/${HERO_RUN_ID}/lineage`);
    await page.getByRole("link", { name: new RegExp(`Test run.+${HERO_RUN_ID}`) }).click();
    await page.waitForURL(`/runs/${HERO_RUN_ID}`);

    const journalTab = page.getByRole("tab", { name: /Journal/ });
    /* Three seeded entries plus the backfill the sync wrote. */
    await expect(journalTab).toContainText("4");
    await journalTab.click();

    const entry = (field: string) =>
      page.getByRole("tabpanel").locator("div.relative").filter({ hasText: field });

    /* The planning system linked the work order. */
    await expect(entry("run.work_order")).toContainText("planning-sync");
    await expect(entry("run.work_order")).toContainText(SYNC_WO_ID);
    await expect(entry("run.work_order")).toContainText("api:planning");
    /* A person typed the operator by hand, and the journal keeps their name. */
    await expect(entry("run.operator")).toContainText("a.bergstrom");
    await expect(entry("run.operator")).toContainText("A. Bergström");
    await expect(entry("run.operator")).toContainText("manual");
    /* The ingestion registered the run by itself. */
    await expect(entry("run.registered")).toContainText("ingestion");
    /* A unit edit made on a signal in this run's context appears here too —
       the journal unions them, so an edit shows where a person made it. */
    await expect(entry("signal.Coolant_Inlet_Temp.unit")).toContainText("°C");
    await expect(entry("signal.Coolant_Inlet_Temp.unit")).toContainText("a.bergstrom");
  });
});
