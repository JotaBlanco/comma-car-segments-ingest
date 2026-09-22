import { getDb, triggerSyncPass } from "@/lib/mock/db";
import { withApi } from "../../_lib/http";

/**
 * Run one sync pass without touching the switch (★) —
 * `POST /planning-sync/trigger`. On an already-synced mock world the pass
 * finds nothing left to backfill and the summary truthfully says 0.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(request, () => Response.json(triggerSyncPass(getDb())));
}
