/**
 * Mock assistant status route (AS-6 — local dev and test rigs only).
 *
 * The real backend is available exactly when the platform injects
 * Quix__Portal__Api (routes registered unconditionally — AI-SIDEBAR.md
 * §5.2; the former TM_ASSISTANT flag left 21 Aug 2026). The mock always answers
 * enabled so the trigger, panel and e2e rig light up under TM_USE_MOCK_API /
 * TM_TEST_HOOKS.
 */

import { withApi } from "../../_lib/http";

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => Response.json({ enabled: true, reachable: true }));
}
