"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { exploreApi } from "@/lib/api/explore";
import { directLakeApi } from "@/lib/api/lake";
import type { ExploreQueryRequest } from "@/types";
import { keys } from "./keys";

export function useExploreContext(runId: string) {
  return useQuery({
    queryKey: keys.runs.exploreContext(runId),
    queryFn: () => exploreApi.context(runId),
    enabled: runId.length > 0,
  });
}

/**
 * Query execution is a mutation on purpose: results are ad-hoc, potentially
 * large, and never cache-shared — each run hits the lake again.
 *
 * The SQL posts to the lake through our own route handler (`/api/lake/query`)
 * — the FastAPI app is not in this path. The run scope lives in the SQL text,
 * so no run id travels with the request.
 */
export function useExploreQuery() {
  return useMutation({
    mutationFn: (body: ExploreQueryRequest) => directLakeApi.query(body),
  });
}
