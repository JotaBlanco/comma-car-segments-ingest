"use client";

import { useQuery } from "@tanstack/react-query";
import { homeApi } from "@/lib/api/home";
import { keys } from "./keys";

export function useHomeSummary() {
  return useQuery({
    queryKey: keys.home,
    queryFn: homeApi.summary,
    // The watcher polls every 30 s. Poll here too, so a new run appears
    // while the presenter stands still.
    refetchInterval: 10_000,
  });
}
