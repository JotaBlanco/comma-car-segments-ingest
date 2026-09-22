"use client";

import { useQuery } from "@tanstack/react-query";
import { searchApi } from "@/lib/api/search";
import { keys } from "./keys";

export function useSearch(q: string, options: { enabled?: boolean; limitPerGroup?: number } = {}) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: keys.search(trimmed, options.limitPerGroup),
    queryFn: () => searchApi.query(trimmed, options.limitPerGroup),
    enabled: (options.enabled ?? true) && trimmed.length > 0,
  });
}
