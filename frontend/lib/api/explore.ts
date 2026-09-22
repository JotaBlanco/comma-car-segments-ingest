import type { ExploreContext } from "@/types";
import { api } from "./client";

/* Query execution does NOT live here: Explore SQL posts to the lake through
   the FE's own `/api/lake/query` route handler (`lib/api/lake.ts`). The
   context stays a backend route — it feeds the scope-strip counts and
   `ai_available`. */

export const exploreApi = {
  context: (runId: string) =>
    api.get<ExploreContext>(`/test-runs/${encodeURIComponent(runId)}/explore/context`),
};
