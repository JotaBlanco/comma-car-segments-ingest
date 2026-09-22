import type {
  PlanningSyncStatus,
  PlanningSyncToggleResponse,
  PlanningSyncTriggerResult,
} from "@/types";
import { api } from "./client";

export const planningSyncApi = {
  status: () => api.get<PlanningSyncStatus>("/planning-sync/status"),
  toggle: (online: boolean) =>
    api.post<PlanningSyncToggleResponse>("/planning-sync/toggle", { online }),
  /**
   * Run one sync pass without touching the switch —
   * `POST /planning-sync/trigger` (`api/api/routers/planning_sync.py`).
   *
   * The route takes no body and answers the status shape plus `push` —
   * what planning's adopting push did (24 Aug 2026) — so the caller can
   * narrate both halves of the pass.
   */
  trigger: () => api.post<PlanningSyncTriggerResult>("/planning-sync/trigger", undefined),
};
